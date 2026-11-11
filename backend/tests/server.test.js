// Tests for backend/src/server.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = require('../src/server');
const { __resetState: resetBlocklists } = require('../src/blocklists');
const { makeApp, listen, openStream } = require('./helpers/app');
const { createTechnitiumServer } = require('./helpers/technitium-mock');

const PACKAGE = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));

const [MAJOR, MINOR] = PACKAGE.version.split('.').map(Number);
// A version that is newer than the running one but sorts earlier as text:
// 2.16.0 is newer than 2.6.1, even though a string compare says otherwise.
const NEWER_VERSION = `${MAJOR}.${MINOR + 10}.0`;
const OLDER_VERSION = `${MAJOR}.${MINOR - 1}.0`;

/** The answer GitHub gives for a release. */
function release(tag, notes = 'What changed.') {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            tag_name: tag,
            html_url: `https://github.com/Hemsby/tdns-stats/releases/tag/${tag}`,
            body: notes,
        }),
    };
}

/** Give the event stream a moment to deliver what the server sends on connect. */
const settle = () => new Promise(resolve => setTimeout(resolve, 150));

test.describe('backend/src/server.js', () => {
    test.describe('session', () => {
        test.it('is signed, and read back out of the cookie header', () => {
            const signed = server.signSession('abc123');

            assert.notEqual(signed, 'abc123');
            assert.equal(server.verifySession(signed), 'abc123');
            assert.deepEqual(server.parseCookies({ headers: { cookie: 'a=1; b=2;  c = 3 ' } }), {
                a: '1',
                b: '2',
                c: '3',
            });
        });

        test.it('is rejected when it has been tampered with', () => {
            const signed = server.signSession('abc123');
            const tampered = signed.slice(0, -1) + (signed.endsWith('a') ? 'b' : 'a');

            assert.equal(server.verifySession(tampered), null);
            // timingSafeEqual throws when the buffers differ in length, so
            // verifySession has to swallow that.
            assert.equal(server.verifySession('abc.'), null);
            assert.equal(server.verifySession('abc'), null);
            assert.equal(server.verifySession(''), null);
            assert.equal(server.verifySession(null), null);
        });

        test.it('reads no cookies when the header has none', () => {
            assert.deepEqual(server.parseCookies({ headers: {} }), {});
        });
    });

    test.describe('protected routes', () => {
        test.it('answer 401 without the session cookie', async t => {
            const { app } = makeApp();
            const api = await listen(app);
            t.after(() => api.close());

            const denied = await api.get('/api/cache/search?domain=www.wikipedia.org');

            assert.equal(denied.status, 401);
            assert.equal(denied.body.error, 'Unauthorized');
        });

        test.it('answer 200 with the session cookie', async t => {
            const { app } = makeApp();
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();

            const allowed = await api.get('/api/cache/search?domain=www.wikipedia.org', { cookie });

            assert.equal(allowed.status, 200);
        });
    });

    test.describe('config route', () => {
        test.it('gives each server a colour from the palette', async t => {
            const { app } = makeApp({
                config: {
                    servers: [
                        { name: 'ns1', url: 'http://127.0.0.1:1', token: 't' },
                        { name: 'ns2', url: 'http://127.0.0.1:1', token: 't' },
                    ],
                },
            });
            const api = await listen(app);
            t.after(() => api.close());

            const res = await api.get('/api/config');

            assert.equal(res.body.serverColors.ns1, 'blue');
            assert.equal(res.body.serverColors.ns2, 'green');
            assert.equal(res.body.maxEntries, 200);
        });

        test.it('keeps the colour a server was given', async t => {
            const { app } = makeApp({
                config: {
                    servers: [{ name: 'ns2', url: 'http://127.0.0.1:1', token: 't', color: 'red' }],
                },
            });
            const api = await listen(app);
            t.after(() => api.close());

            const res = await api.get('/api/config');

            assert.equal(res.body.serverColors.ns2, 'red');
        });
    });

    test.describe('cache search route', () => {
        test.it('reports a name the server holds as cached, and one it does not as not cached', async t => {
            const technitium = await createTechnitiumServer({
                cache: {
                    names: {
                        'www.wikipedia.org': [
                            { name: 'www.wikipedia.org', type: 'A', ttl: '300 (5 mins)', rData: { ipAddress: '93.184.216.34' } },
                        ],
                    },
                },
            }).start();
            t.after(() => technitium.stop());

            const { app } = makeApp({
                config: { servers: [{ name: 'ns1', url: technitium.url, token: 't' }] },
            });
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();
            const search = domain => api.get(`/api/cache/search?domain=${encodeURIComponent(domain)}`, { cookie });

            const held = await search('www.wikipedia.org');
            assert.equal(held.status, 200);
            assert.equal(held.body.results.length, 1);
            assert.equal(held.body.results[0].ok, true);
            assert.equal(held.body.results[0].cached, true);
            assert.equal(held.body.results[0].recordCount, 1);

            // The name is not in the cache, so the server has nothing to say
            // about it. It is not cached, and it did not fail either.
            const missing = await search('api.github.com');
            assert.equal(missing.status, 200);
            assert.equal(missing.body.results[0].ok, true);
            assert.equal(missing.body.results[0].cached, false);
            assert.equal(missing.body.results[0].recordCount, 0);
        });

        test.it('rejects a domain the cache search cannot work with', async t => {
            const { app } = makeApp();
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();
            const search = domain => api.get(`/api/cache/search?domain=${encodeURIComponent(domain)}`, { cookie });

            assert.equal((await search('')).status, 400);
            assert.equal((await search('.www.wikipedia.org')).status, 400);
            assert.equal((await search('www.wikipedia.org.')).status, 400);
            assert.equal((await search('www.wikipedia..org')).status, 400);
            assert.equal((await search('localhost')).status, 400);
            assert.equal((await search(`${'a'.repeat(64)}.com`)).status, 400);
            assert.equal(
                (await search(`${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(60)}.com`)).status,
                400,
            );
            assert.equal((await search('www.wikipedia.org')).status, 200);
        });
    });

    test.describe('blocked lookup route', () => {
        test.it('reports every block list the server named for a domain', async t => {
            const technitium = await createTechnitiumServer({
                resolve: query => ({
                    result: {
                        Question: [{ Name: query.domain, Type: 'TXT', Class: 'IN' }],
                        Answer: [
                            {
                                Name: query.domain,
                                Type: 'TXT',
                                Class: 'IN',
                                TTL: 3600,
                                RDATA: {
                                    CharacterStrings: [
                                        'source=block-list-zone; blockListUrl=https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/light-onlydomains.txt; domain=ads.doubleclick.net',
                                    ],
                                },
                            },
                            {
                                Name: query.domain,
                                Type: 'TXT',
                                Class: 'IN',
                                TTL: 3600,
                                RDATA: {
                                    CharacterStrings: [
                                        'source=block-list-zone; blockListUrl=https://big.oisd.nl/domainswild2; domain=ads.doubleclick.net',
                                    ],
                                },
                            },
                        ],
                        Authority: [],
                        Additional: [],
                    },
                    rawResponses: [],
                }),
            }).start();
            t.after(() => technitium.stop());

            const { app } = makeApp({
                config: { servers: [{ name: 'ns1', url: technitium.url, token: 't' }] },
            });
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();
            const search = await api.get('/api/cache/search?domain=ads.doubleclick.net&blocked=1', { cookie });

            assert.equal(search.status, 200);
            assert.equal(search.body.blockedSummary.ok, true);
            assert.equal(search.body.blockedSummary.blocked, true);
            // A name can be on more than one block list, and the dashboard
            // shows every list the server named, not only the first.
            assert.deepEqual(
                search.body.blockedSummary.lists.map(list => list.url),
                [
                    'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/light-onlydomains.txt',
                    'https://big.oisd.nl/domainswild2',
                ],
            );
        });

        test.it('says a name that resolved normally is not blocked', async t => {
            // The answer carries a record, but no blocking report: a name that
            // resolved is not a name that was blocked.
            const technitium = await createTechnitiumServer({
                resolve: query => ({
                    result: {
                        Question: [{ Name: query.domain, Type: query.type, Class: 'IN' }],
                        Answer: [{ Name: query.domain, Type: query.type, Class: 'IN', TTL: 3600, RDATA: { IPAddress: '77.91.110.3' } }],
                        Authority: [],
                        Additional: [],
                    },
                    rawResponses: [],
                }),
            }).start();
            t.after(() => technitium.stop());

            const { app } = makeApp({
                config: { servers: [{ name: 'ns1', url: technitium.url, token: 't' }] },
            });
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();
            const search = await api.get('/api/cache/search?domain=ads.doubleclick.net&blocked=1', { cookie });

            assert.equal(search.status, 200);
            assert.equal(search.body.blockedSummary.ok, true);
            assert.equal(search.body.blockedSummary.blocked, false);
            assert.deepEqual(search.body.blockedSummary.lists, []);
        });
    });

    test.describe('cache search targets', () => {
        test.it('searches every node of the cluster when the cluster is asked for', async t => {
            const ns1 = await createTechnitiumServer({ name: 'ns1.cluster.home.arpa' }).start();
            const ns2 = await createTechnitiumServer({ name: 'ns2.cluster.home.arpa' }).start();
            t.after(() => ns1.stop());
            t.after(() => ns2.stop());

            const { app } = makeApp({
                config: { servers: [{ name: 'ns1', url: ns1.url, token: 't' }] },
                state: {
                    nodes: {
                        ns1: { dnsServerDomain: 'ns1.cluster.home.arpa', clusterInitialized: true },
                        __cluster: {
                            clusterDomain: 'cluster.home.arpa',
                            clusterNodes: [
                                { id: 'node-1', name: 'ns1.cluster.home.arpa', url: ns1.url },
                                { id: 'node-2', name: 'ns2.cluster.home.arpa', url: ns2.url },
                            ],
                        },
                    },
                    top: {},
                    perf: {},
                    rttSeries: {},
                },
            });
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();

            const res = await api.get('/api/cache/search?domain=www.wikipedia.org&server=__cluster', { cookie });

            assert.equal(res.status, 200);
            assert.equal(res.body.cluster, true);
            assert.equal(res.body.searchedAllNodes, true);
            // Both nodes of the cluster were asked, and the server in the config
            // is the same as the first node of the cluster, so it is not asked twice.
            assert.deepEqual(res.body.results.map(r => r.server).sort(), ['ns1.cluster.home.arpa', 'ns2.cluster.home.arpa']);
        });

        test.it('answers 404 for a server it does not know', async t => {
            const { app } = makeApp();
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();

            const res = await api.get('/api/cache/search?domain=www.wikipedia.org&server=nope', { cookie });

            assert.equal(res.status, 404);
            assert.equal(res.body.error, 'Unknown server');
        });
    });

    test.describe('popover lookup', () => {
        test.beforeEach(() => resetBlocklists());

        test.it('answers with the blocked summary and no cache listing', async t => {
            const technitium = await createTechnitiumServer({
                resolve: query => ({
                    result: {
                        Question: [{ Name: query.domain, Type: query.type, Class: 'IN' }],
                        Answer: [
                            {
                                Name: query.domain,
                                Type: query.type,
                                Class: 'IN',
                                TTL: 3600,
                                RDATA: {
                                    CharacterStrings: [
                                        'source=block-list-zone; blockListUrl=https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/light-onlydomains.txt; domain=ads.doubleclick.net',
                                    ],
                                },
                            },
                        ],
                        Authority: [],
                        Additional: [],
                    },
                    rawResponses: [],
                }),
            }).start();
            t.after(() => technitium.stop());

            const { app } = makeApp({
                config: { servers: [{ name: 'ns1', url: technitium.url, token: 't' }] },
            });
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();

            // The popover asks for the blocked summary with the cache listing
            // switched off, so the answer carries no per-node results.
            const res = await api.get('/api/cache/search?domain=ads.doubleclick.net&server=ns1&blocked=1&cache=0', { cookie });

            assert.equal(res.status, 200);
            assert.equal(res.body.blockedLookup, true);
            assert.equal(res.body.blockedSummary.ok, true);
            assert.equal(res.body.blockedSummary.blocked, true);
            assert.deepEqual(
                res.body.blockedSummary.lists.map(list => list.name),
                ['HaGeZi Multi LIGHT'],
            );
            assert.deepEqual(res.body.results, []);
            assert.equal(res.body.cachedNodeCount, 0);
            assert.equal(res.body.recordCount, 0);
        });

        test.it('says the lookup failed when the server cannot answer', async t => {
            const technitium = await createTechnitiumServer().start();
            t.after(() => technitium.stop());

            technitium.fail('/api/dnsClient/resolve', 500);

            const { app } = makeApp({
                config: { servers: [{ name: 'ns1', url: technitium.url, token: 't' }] },
            });
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();

            const res = await api.get('/api/cache/search?domain=ads.doubleclick.net&server=ns1&blocked=1&cache=0', { cookie });

            assert.equal(res.status, 200);
            // The summary says the report could not be read, and names no list.
            assert.match(res.body.blockedSummary.reportError, /could not be read/);
            assert.deepEqual(res.body.blockedSummary.lists, []);
            assert.equal(res.body.blockedSummary.blocked, false);
        });
    });

    test.describe('watch route', () => {
        test.it('watches a server they know', async t => {
            const { app, calls } = makeApp();
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();

            await api.get('/api/watch-server?server=ns1', { cookie });

            assert.deepEqual(
                calls.filter(c => c.startsWith('watch:')),
                ['watch:ns1'],
            );
        });

        test.it('ignores a watch request for a server they do not know', async t => {
            const { app, calls } = makeApp();
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();

            await api.get('/api/watch-server?server=nope', { cookie });

            assert.deepEqual(
                calls.filter(c => c.startsWith('watch:')),
                [],
            );
        });
    });

    test.describe('block list stats route', () => {
        test.it('reports the counts of a server it knows', async t => {
            const technitium = await createTechnitiumServer().start();
            t.after(() => technitium.stop());

            const { app } = makeApp({
                config: {
                    servers: [
                        {
                            name: 'ns1',
                            url: technitium.url,
                            token: 't',
                            queryLogsApp: { name: 'Query Logs (Sqlite)', classPath: 'QueryLogsSqlite.App' },
                        },
                    ],
                },
            });
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();

            const res = await api.post('/api/block-list-stats?server=ns1', { cookie });

            // The route answers with the blocked summary of the server it was
            // asked about. The query log app has not been discovered yet, so
            // the summary says the logs are not available.
            assert.equal(res.status, 200);
            assert.equal(res.body.ok, false);
            assert.match(res.body.error, /Query logs/);
        });

        test.it('answers 404 for a server they do not know', async t => {
            const { app } = makeApp();
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();

            const res = await api.post('/api/block-list-stats?server=nope', { cookie });

            assert.equal(res.status, 404);
            assert.equal(res.body.ok, false);
        });
    });

    test.describe('update route', () => {
        test.it('starts the update when the updater can update', async t => {
            const { app } = makeApp({ updater: { capable: true, executeUpdate: async () => 'updated' } });
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();

            const res = await api.post('/api/updates/trigger', { cookie });

            assert.equal(res.status, 200);
            assert.equal(res.body.status, 'update_started');
        });

        test.it('answers 403 when the updater cannot update', async t => {
            const { app } = makeApp();
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();

            const res = await api.post('/api/updates/trigger', { cookie });

            assert.equal(res.status, 403);
        });
    });

    test.describe('update check route', () => {
        test.it('reports a release that is newer than the running one', async t => {
            server.__setFetch(async () => release('v99.0.0', 'What changed.'));
            t.after(() => server.__setFetch(null));

            const { app } = makeApp();
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();
            const stream = await openStream(api.port, cookie);
            t.after(() => stream.req.destroy());

            const res = await api.get('/api/updates/check', { cookie });

            assert.equal(res.status, 200);
            assert.equal(res.body.currentVersion, PACKAGE.version);
            assert.equal(res.body.latestVersion, '99.0.0');
            assert.equal(res.body.updateAvailable, true);
            assert.equal(res.body.downloadUrl, 'https://github.com/Hemsby/tdns-stats/releases/tag/v99.0.0');
            assert.equal(res.body.releaseNotes, 'What changed.');

            // The stream carries the answer, which is what puts the update
            // button on the page.
            await settle();
            assert.match(stream.text(), /"status":"checked"/);
            assert.match(stream.text(), /"updateAvailable":true/);
        });

        test.it('answers 502 when the release cannot be looked up', async t => {
            server.__setFetch(async () => {
                throw new Error('the network is down');
            });
            t.after(() => server.__setFetch(null));

            const { app } = makeApp();
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();
            const res = await api.get('/api/updates/check', { cookie });

            assert.equal(res.status, 502);
            assert.equal(res.body.error, 'Failed to check updates');
        });
    });

    test.describe('release comparison', () => {
        test.it('calls a newer version newer, however the numbers are written', async t => {
            server.__setFetch(async () => release(`v${NEWER_VERSION}`));
            t.after(() => server.__setFetch(null));

            const { app } = makeApp();
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();
            const res = await api.get('/api/updates/check', { cookie });

            assert.equal(res.body.updateAvailable, true);
        });

        test.it('does not offer a release that is the same version, an older one, or none at all', async t => {
            const answers = [release(`v${PACKAGE.version}`), release(`v${OLDER_VERSION}`), { ok: false, status: 404 }];
            server.__setFetch(async () => answers.shift());
            t.after(() => server.__setFetch(null));

            const { app } = makeApp();
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();

            const same = await api.get('/api/updates/check', { cookie });
            const older = await api.get('/api/updates/check', { cookie });
            const none = await api.get('/api/updates/check', { cookie });

            assert.equal(same.body.updateAvailable, false);
            assert.equal(older.body.updateAvailable, false);

            // A repository with no releases is not an error, it is no update.
            assert.equal(none.status, 200);
            assert.equal(none.body.updateAvailable, false);
            assert.equal(none.body.currentVersion, PACKAGE.version);
        });
    });

    test.describe('version route', () => {
        test.it('reports the version from the package file', async t => {
            const { app } = makeApp();
            const api = await listen(app);
            t.after(() => api.close());

            const res = await api.get('/api/version');

            assert.equal(res.body.version, PACKAGE.version);
        });
    });

    test.describe('event stream', () => {
        test.it('sends the cached state and resumes the poller', async t => {
            const { app, calls } = makeApp({
                state: {
                    nodes: { ns1: { name: 'ns1' } },
                    top: { ns1: { topDomains: [] } },
                    perf: { ns1: { rtt: {} } },
                    rttSeries: { ns1: [{ t: 'x', mean: 1 }] },
                },
            });
            const api = await listen(app);
            t.after(() => api.close());

            const cookie = await api.cookie();
            const stream = await openStream(api.port, cookie);
            t.after(() => stream.req.destroy());

            await settle();

            const sent = stream.text();
            assert.match(sent, /"type":"top"/);
            assert.match(sent, /"type":"stats"/);
            assert.match(sent, /"type":"perf"/);
            assert.match(sent, /"type":"perf-series"/);
            assert.ok(calls.includes('resume'));
            assert.ok(calls.includes('refreshRangeData'));

            // The poller is paused again when the last client leaves.
            stream.req.destroy();
            await settle();

            assert.ok(calls.includes('pause'));
        });

        test.it('answers 401 without the session cookie', async t => {
            const { app } = makeApp();
            const api = await listen(app);
            t.after(() => api.close());

            const res = await api.get('/api/stream');

            assert.equal(res.status, 401);
        });
    });
});
