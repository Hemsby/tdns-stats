// Tests for backend/src/blocklists.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTechnitiumServer } = require('./helpers/technitium-mock');
const {
    listsForDomain,
    summarizeBlockedLog,
    redactListUrl,
    isBlockedName,
    listsFromReportStrings,
    listDisplayName,
    parseBlockingReport,
    isBlockingReport,
    parseDnsClientExtraText,
    collectTxtStrings,
    collectStringValues,
    extractDnsClientRecords,
    hageziNrdEnd,
    isLoopbackClient,
    clientIp,
    __resetState,
} = require('../src/blocklists');

// The reports a real server sends, the way Technitium v15.6.2 sends them.
const HAGEZI_LIGHT_URL = 'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/light-onlydomains.txt';
const OISD_BIG_URL = 'https://big.oisd.nl/domainswild2';
const NRD_7_URL = 'https://cdn.jsdelivr.net/gh/hagezi/nrd@latest/domains/nrd7.txt';
const URLHAUS_URL = 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-domains.txt';
const STEVENBLACK_URL = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts';
const BLOCKING_REPORT = `source=block-list-zone; blockListUrl=${HAGEZI_LIGHT_URL}; domain=ads.doubleclick.net`;
const ADVANCED_REPORT = `source=advanced-blocking-app; group=Advertising; blockListUrl=${STEVENBLACK_URL}; domain=ads.doubleclick.net`;
const MANUAL_REPORT = 'source=blocked-zone; domain=ads.doubleclick.net';

/** A TXT answer that carries the blocking report, the way a server sends it. */
function txtReport(text) {
    return {
        result: {
            Question: [{ Name: 'ads.doubleclick.net', Type: 'TXT', Class: 'IN' }],
            Answer: [{ Name: 'ads.doubleclick.net', Type: 'TXT', Class: 'IN', TTL: 3600, RDATA: { CharacterStrings: [text] } }],
            Authority: [],
            Additional: [],
        },
        rawResponses: [],
    };
}

/** A server with a query log app, which is what the count lists need. */
function serverWithLog(fake, name = 'ns1') {
    return fake.serverConfig(name, {
        queryLogsApp: { name: 'Query Logs (Sqlite)', classPath: 'QueryLogsSqlite.App' },
    });
}

/** A row in the query log, the way a server sends it. */
function blockedEntry(qname, clientIp = '89.160.20.112') {
    return {
        rowNumber: 1,
        timestamp: new Date().toISOString(),
        clientIpAddress: clientIp,
        protocol: 'Udp',
        responseType: 'Blocked',
        rcode: 'NoError',
        qname,
        qtype: 'A',
        qclass: 'IN',
    };
}

test.describe('backend/src/blocklists.js', () => {
    test.describe('blocked lookup', () => {
        test.beforeEach(() => __resetState());

        test.it('names the list that blocked the domain', async t => {
            const fake = await createTechnitiumServer({ dnsClient: txtReport(BLOCKING_REPORT) }).start();
            t.after(() => fake.stop());

            const found = await listsForDomain(fake.serverConfig(), 'ads.doubleclick.net');

            assert.equal(found.ok, true);
            assert.equal(found.lists.length, 1);
            assert.equal(found.lists[0].url, HAGEZI_LIGHT_URL);
            assert.equal(found.lists[0].source, 'block-list-zone');
            assert.equal(found.lists[0].name, 'HaGeZi Multi LIGHT');

            // The list matched the name itself, not the name that was asked for.
            const sub = await listsForDomain(fake.serverConfig(), 'static.ads.doubleclick.net');
            assert.equal(sub.lists[0].matchedDomain, 'ads.doubleclick.net');

            // The second lookup of a name is answered from the cache.
            const stats = { lookups: 0, cacheHits: 0 };
            const first = await listsForDomain(fake.serverConfig(), 'cdn.adsrvr.org', stats);
            const second = await listsForDomain(fake.serverConfig(), 'cdn.adsrvr.org', stats);
            assert.equal(second, first);
            assert.equal(stats.lookups, 1);
            assert.equal(stats.cacheHits, 1);
        });

        test.it('reports a failure when the lookup fails', async t => {
            const fake = await createTechnitiumServer().start();
            t.after(() => fake.stop());

            fake.fail('/api/dnsClient/resolve', 500);

            const found = await listsForDomain(fake.serverConfig(), 'ads.doubleclick.net');

            assert.equal(found.ok, false);
            assert.deepEqual(found.lists, []);
        });
    });

    test.describe('list URL', () => {
        test.it('keeps an ordinary URL as it is', () => {
            assert.equal(redactListUrl(HAGEZI_LIGHT_URL), HAGEZI_LIGHT_URL);
        });

        test.it('takes the credentials out of a URL', () => {
            const url = redactListUrl('https://user:pass@raw.githubusercontent.com/StevenBlack/hosts/master/hosts?token=abc123');

            assert.ok(!url.includes('abc123'), 'the token is still in the url');
            assert.ok(!url.includes('user:pass'), 'the credentials are still in the url');
            assert.match(url, /redacted/);
        });
    });

    test.describe('report grammar', () => {
        test.it('reads the key and the value of every part', () => {
            const parsed = parseBlockingReport(BLOCKING_REPORT);

            assert.equal(parsed.source, 'block-list-zone');
            // The keys are read the way the dashboard lowercases them.
            assert.equal(parsed.blocklisturl, HAGEZI_LIGHT_URL);
            assert.equal(parsed.domain, 'ads.doubleclick.net');
        });

        test.it('skips a part that has no value', () => {
            const parsed = parseBlockingReport('source=block-list-zone; rubbish; domain=ads.doubleclick.net');

            assert.deepEqual(parsed, { source: 'block-list-zone', domain: 'ads.doubleclick.net' });
        });

        test.it('knows a report from its source or from its list', () => {
            assert.equal(isBlockingReport({ source: 'block-list-zone' }), true);
            assert.equal(isBlockingReport({ source: 'blocked-zone' }), true);
            assert.equal(isBlockingReport({ source: 'advanced-blocking-app' }), true);
            assert.equal(isBlockingReport({ blocklisturl: HAGEZI_LIGHT_URL }), true);
        });

        test.it('does not see a report in a name alone', () => {
            assert.equal(isBlockingReport({ domain: 'ads.doubleclick.net' }), false);
        });

        test.it('reads a value that follows its key', () => {
            const parsed = parseDnsClientExtraText('source=block-list-zone\nblock-list-zone');

            assert.equal(parsed.source, 'block-list-zone');
            assert.equal(parseDnsClientExtraText('source: block-list-zone').source, 'block-list-zone');
        });

        test.it('leaves out a value it cannot read', () => {
            assert.deepEqual(parseDnsClientExtraText('nonsense'), {});
        });
    });

    test.describe('TXT answer', () => {
        test.it('finds the report wherever the server put it', () => {
            const strings = collectTxtStrings(txtReport(BLOCKING_REPORT).result);
            const elsewhere = collectStringValues({ extraText: BLOCKING_REPORT });

            assert.deepEqual(strings, [BLOCKING_REPORT]);
            assert.deepEqual(elsewhere, [BLOCKING_REPORT]);
        });

        test.it('keeps only the records that look like records', () => {
            const records = extractDnsClientRecords({
                records: [{ type: 'A', address: '77.91.110.3' }, { nothing: true }],
                extra: 'ignored',
            });

            assert.equal(records.length, 1);
            assert.equal(records[0].address, '77.91.110.3');
        });
    });

    test.describe('list names', () => {
        test.it('names the lists it knows', () => {
            assert.equal(listDisplayName(HAGEZI_LIGHT_URL), 'HaGeZi Multi LIGHT');
            assert.equal(listDisplayName(OISD_BIG_URL), 'OISD Big');
            assert.equal(listDisplayName('', 'blocked-zone'), 'Manual block list');
        });

        test.it('falls back to the file name for a list it does not know', () => {
            assert.equal(listDisplayName(URLHAUS_URL), 'urlhaus-filter-domains.txt');
        });

        test.it('reads the days of a HaGeZi NRD list from its url', () => {
            assert.equal(hageziNrdEnd(NRD_7_URL), 7);
        });

        test.it('finds no days in a list that is not an NRD list', () => {
            assert.equal(hageziNrdEnd(HAGEZI_LIGHT_URL), 0);
        });
    });

    test.describe('lists a report names', () => {
        test.it('names the list, the source and the group a report carries', () => {
            const advanced = listsFromReportStrings([ADVANCED_REPORT], 'ads.doubleclick.net');
            const manual = listsFromReportStrings([MANUAL_REPORT], 'ads.doubleclick.net');
            const nrd = listsFromReportStrings(
                [`source=block-list-zone; blockListUrl=${NRD_7_URL}; domain=ads.doubleclick.net`],
                'ads.doubleclick.net',
            );

            assert.equal(advanced[0].source, 'advanced-blocking-app');
            assert.equal(advanced[0].url, STEVENBLACK_URL);
            assert.equal(manual[0].name, 'Manual block list');
            assert.equal(manual[0].source, 'blocked-zone');
            assert.equal(nrd[0].group, 'hagezi-nrd');
            assert.equal(nrd[0].nrdEnd, 7);
        });

        test.it('keeps one entry for a list that is named twice', () => {
            const lists = listsFromReportStrings([BLOCKING_REPORT, BLOCKING_REPORT], 'ads.doubleclick.net');

            assert.equal(lists.length, 1);
            assert.deepEqual(listsFromReportStrings(['domain=ads.doubleclick.net'], 'ads.doubleclick.net'), []);
        });
    });

    test.describe('blocked rule', () => {
        test.it('is true when the server says the name is blocked', () => {
            assert.equal(isBlockedName({}, [{ name: 'HaGeZi Multi LIGHT' }]), true);
            assert.equal(isBlockedName({ source: 'block-list-zone' }, []), true);
            assert.equal(isBlockedName({ group: 'Advertising' }, []), true);
            assert.equal(isBlockedName({ parsed: { source: 'block-list-zone' } }, []), true);
            assert.equal(isBlockedName({ extraText: BLOCKING_REPORT }, []), true);
        });

        test.it('is false for a name that resolved normally', () => {
            // The records of the answer are not a signal: a name that resolved
            // has records too.
            assert.equal(isBlockedName({ records: [{ type: 'A', address: '77.91.110.3' }] }, []), false);
        });
    });

    test.describe('row client', () => {
        test.it('reads the client out of a row', () => {
            assert.equal(clientIp({ clientIpAddress: '89.160.20.112' }), '89.160.20.112');
            assert.equal(clientIp({ clientIP: '84.64.15.7' }), '84.64.15.7');
        });

        test.it('knows a loopback client and has no client for an empty row', () => {
            assert.equal(isLoopbackClient('127.0.0.1'), true);
            assert.equal(isLoopbackClient('::1'), true);
            assert.equal(isLoopbackClient('::ffff:127.0.0.1'), true);
            assert.equal(isLoopbackClient('89.160.20.112'), false);
            assert.equal(clientIp({}), '');
        });
    });

    test.describe('report cache', () => {
        test.beforeEach(() => __resetState());

        test.it('keeps a report for half an hour', async t => {
            const fake = await createTechnitiumServer({ dnsClient: txtReport(BLOCKING_REPORT) }).start();
            t.after(() => fake.stop());

            const stats = { lookups: 0, cacheHits: 0 };
            await listsForDomain(fake.serverConfig(), 'ads.doubleclick.net', stats);

            // The second lookup is answered from the cache.
            await listsForDomain(fake.serverConfig(), 'ads.doubleclick.net', stats);
            assert.equal(stats.lookups, 1);
            assert.equal(stats.cacheHits, 1);

            // Just before half an hour the report is still there.
            t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
            t.mock.timers.tick(29 * 60 * 1000);
            await listsForDomain(fake.serverConfig(), 'ads.doubleclick.net', stats);
            assert.equal(stats.lookups, 1);
            assert.equal(stats.cacheHits, 2);

            // After half an hour the server is asked again.
            t.mock.timers.tick(2 * 60 * 1000);
            await listsForDomain(fake.serverConfig(), 'ads.doubleclick.net', stats);
            assert.equal(stats.lookups, 2);
        });

        test.it('keeps a name with no list for ten minutes', async t => {
            const fake = await createTechnitiumServer({
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
            t.after(() => fake.stop());

            const stats = { lookups: 0, cacheHits: 0 };
            await listsForDomain(fake.serverConfig(), 'cdn.adsrvr.org', stats);
            await listsForDomain(fake.serverConfig(), 'cdn.adsrvr.org', stats);
            assert.equal(stats.lookups, 1);
            assert.equal(stats.cacheHits, 1);

            // Just before ten minutes the empty answer is still there.
            t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
            t.mock.timers.tick(9 * 60 * 1000);
            await listsForDomain(fake.serverConfig(), 'cdn.adsrvr.org', stats);
            assert.equal(stats.lookups, 1);
            assert.equal(stats.cacheHits, 2);

            // After ten minutes the server is asked again.
            t.mock.timers.tick(2 * 60 * 1000);
            await listsForDomain(fake.serverConfig(), 'cdn.adsrvr.org', stats);
            assert.equal(stats.lookups, 2);
        });
    });

    test.describe('failed report cache', () => {
        test.beforeEach(() => __resetState());

        test.it('keeps a lookup that failed for a minute', async t => {
            const fake = await createTechnitiumServer().start();
            t.after(() => fake.stop());

            fake.fail('/api/dnsClient/resolve', 500);

            const stats = { lookups: 0, cacheHits: 0 };
            const failed = await listsForDomain(fake.serverConfig(), 'ads.doubleclick.net', stats);
            assert.equal(failed.ok, false);

            // The failure is remembered, so the server is not asked again at once.
            await listsForDomain(fake.serverConfig(), 'ads.doubleclick.net', stats);
            assert.equal(stats.lookups, 1);
            assert.equal(stats.cacheHits, 1);

            // A minute later it is asked again.
            t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
            t.mock.timers.tick(61 * 1000);
            await listsForDomain(fake.serverConfig(), 'ads.doubleclick.net', stats);
            assert.equal(stats.lookups, 2);
        });

        test.it('asks again at once when the lookup never failed', async t => {
            const fake = await createTechnitiumServer({ dnsClient: txtReport(BLOCKING_REPORT) }).start();
            t.after(() => fake.stop());

            const stats = { lookups: 0, cacheHits: 0 };
            await listsForDomain(fake.serverConfig(), 'ads.doubleclick.net', stats);

            // A name that was looked up and found is cached, so the second
            // lookup does not reach the server either.
            await listsForDomain(fake.serverConfig(), 'ads.doubleclick.net', stats);
            assert.equal(stats.lookups, 1);
            assert.equal(stats.cacheHits, 1);
        });
    });

    test.describe('count pages', () => {
        test.beforeEach(() => __resetState());

        test.it('stops after twenty pages and says the list was cut short', async t => {
            // Twenty-one pages of a thousand blocked queries each.
            const entries = Array.from({ length: 20001 }, (_, i) => blockedEntry('ads.doubleclick.net', '89.160.20.' + (i % 250)));
            const fake = await createTechnitiumServer({ dnsClient: txtReport(BLOCKING_REPORT), logEntries: entries }).start();
            t.after(() => fake.stop());

            const result = await summarizeBlockedLog([serverWithLog(fake)]);

            assert.equal(result.ok, true);
            assert.equal(result.pagesFetched, 20);
            assert.equal(result.totalPages, 21);
            assert.equal(result.truncated, true);
            // The twentieth page holds a thousand queries, so twenty thousand were counted.
            assert.equal(result.blockedQueries, 20000);
        });

        test.it('reads every page when there are fewer than twenty', async t => {
            const entries = Array.from({ length: 2500 }, (_, i) => blockedEntry('ads.doubleclick.net', '89.160.20.' + (i % 250)));
            const fake = await createTechnitiumServer({ dnsClient: txtReport(BLOCKING_REPORT), logEntries: entries }).start();
            t.after(() => fake.stop());

            const result = await summarizeBlockedLog([serverWithLog(fake)]);

            assert.equal(result.pagesFetched, 3);
            assert.equal(result.totalPages, 3);
            assert.equal(result.truncated, false);
            assert.equal(result.blockedQueries, 2500);
        });
    });

    test.describe('count runs', () => {
        test.beforeEach(() => __resetState());

        test.it('runs the count once when two clicks ask for it at the same time', async t => {
            const fake = await createTechnitiumServer({
                dnsClient: txtReport(BLOCKING_REPORT),
                logEntries: [blockedEntry('www.google.com'), blockedEntry('www.youtube.com')],
            }).start();
            t.after(() => fake.stop());

            const servers = [serverWithLog(fake)];
            const [first, second] = await Promise.all([summarizeBlockedLog(servers), summarizeBlockedLog(servers)]);

            // Both clicks are answered by the one run.
            assert.deepEqual(first, second);
            assert.equal(first.blockedQueries, 2);

            // The log was read once, not twice.
            const logReads = fake.requests.filter(r => r.path === '/api/logs/query');
            assert.equal(logReads.length, 1);
        });

        test.it('runs the count again for a click that comes later', async t => {
            const fake = await createTechnitiumServer({
                dnsClient: txtReport(BLOCKING_REPORT),
                logEntries: [blockedEntry('www.google.com')],
            }).start();
            t.after(() => fake.stop());

            const servers = [serverWithLog(fake)];
            await summarizeBlockedLog(servers);
            await summarizeBlockedLog(servers);

            // The first run is not remembered: a later click counts again.
            const logReads = fake.requests.filter(r => r.path === '/api/logs/query');
            assert.equal(logReads.length, 2);
        });
    });

    test.describe('blocked count', () => {
        test.beforeEach(() => __resetState());

        test.it('groups the blocked names by list', async t => {
            const fake = await createTechnitiumServer({
                dnsClient: txtReport(BLOCKING_REPORT),
                logEntries: [blockedEntry('www.google.com'), blockedEntry('www.google.com'), blockedEntry('www.youtube.com')],
            }).start();
            t.after(() => fake.stop());

            const result = await summarizeBlockedLog([serverWithLog(fake)]);

            assert.equal(result.ok, true);
            assert.equal(result.blockedQueries, 3);
            assert.equal(result.domains, 2);
            assert.equal(result.lists.length, 1);
            assert.equal(result.lists[0].hits, 3);
            assert.equal(result.lists[0].domains, 2);
            assert.equal(result.lists[0].name, 'HaGeZi Multi LIGHT');

            // The queries the server made itself are not counted.
            const own = await createTechnitiumServer({
                dnsClient: txtReport(BLOCKING_REPORT),
                logEntries: [
                    blockedEntry('www.google.com', '127.0.0.1'),
                    blockedEntry('www.youtube.com', '::1'),
                    blockedEntry('cdn.adsrvr.org'),
                ],
            }).start();
            t.after(() => own.stop());

            const skipped = await summarizeBlockedLog([serverWithLog(own)]);
            assert.equal(skipped.skippedLoopback, 2);
            assert.equal(skipped.blockedQueries, 1);

            // No more names than the limit allows are looked up.
            const many = await createTechnitiumServer({
                dnsClient: txtReport(BLOCKING_REPORT),
                logEntries: Array.from({ length: 1001 }, (_, i) => blockedEntry(`n${i}.home.arpa`)),
            }).start();
            t.after(() => many.stop());

            const capped = await summarizeBlockedLog([serverWithLog(many)]);

            assert.equal(capped.lookupLimit, 1000);
            assert.equal(capped.lookups, 1000);
            // One name fell over the cap, so it was counted but never looked up.
            assert.equal(capped.limited.names, 1);
            assert.equal(capped.limited.hits, 1);
            assert.equal(capped.domains, 1001);
        });

        test.it('reports that the query log is unavailable', async t => {
            const fake = await createTechnitiumServer().start();
            t.after(() => fake.stop());

            const result = await summarizeBlockedLog([fake.serverConfig()]);

            assert.equal(result.ok, false);
            assert.match(result.error, /Query logs/);
            assert.equal(result.blockedQueries, 0);
        });
    });
});
