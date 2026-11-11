// Tests for backend/tests/helpers/technitium-mock.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTechnitiumServer } = require('../helpers/technitium-mock');
const { getDashboard, getSessionInfo, getTopStats, getQueryLogs, getRttSample } = require('../../src/technitium');

/** A server the production code can talk to. */
function configFor(mock, extra = {}) {
    return {
        name: 'ns1',
        url: mock.url,
        token: 'test-token',
        ignoreSsl: false,
        queryLogsAppName: null,
        queryLogsApp: { name: 'Query Logs (Sqlite)', classPath: 'QueryLogsSqlite.App' },
        ...extra,
    };
}

test.describe('backend/tests/helpers/technitium-mock.js', () => {
    test.describe('answers', () => {
        test.it('answers the session, the dashboard and the top lists the way the dashboard reads them', async t => {
            const mock = await createTechnitiumServer().start();
            t.after(() => mock.stop());

            const info = await getSessionInfo(configFor(mock));
            assert.equal(info.version, '15.6.2');
            assert.equal(info.dnsServerDomain, 'ns1.home.arpa');

            const dash = await getDashboard(configFor(mock));
            assert.ok(dash.stats.totalQueries > 0);
            assert.ok(dash.mainChartData.labels.length > 0);
            assert.ok(dash.mainChartData.datasets.length > 0);

            for (const [statsType, key] of [
                ['TopDomains', 'topDomains'],
                ['TopBlockedDomains', 'topBlockedDomains'],
                ['TopClients', 'topClients'],
            ]) {
                const top = await getTopStats(configFor(mock), statsType, 5);
                assert.ok(top[key].length > 0, `${statsType} is empty`);
                // The server answers with as many rows as were asked for.
                assert.ok(top[key].length <= 5);
            }
        });

        test.it('answers the query log newest first and the RTT sample with the recursive rows', async t => {
            const mock = await createTechnitiumServer().start();
            t.after(() => mock.stop());

            const logs = await getQueryLogs(configFor(mock), 20);

            assert.ok(logs.entries.length > 0);
            const times = logs.entries.map(entry => new Date(entry.timestamp).getTime());
            assert.deepEqual(
                times,
                [...times].sort((a, b) => b - a),
                'the log is not newest first',
            );

            const sample = await getRttSample(configFor(mock), 50);
            assert.ok(sample.length > 0);
            for (const entry of sample) assert.equal(typeof entry.rtt, 'number');
        });

        test.it('answers a name that is blocked with the lists that blocked it', async t => {
            const mock = await createTechnitiumServer().start();
            t.after(() => mock.stop());

            const reports = domain =>
                fetch(`${mock.url}/api/dnsClient/resolve?domain=${encodeURIComponent(domain)}&type=TXT`)
                    .then(r => r.json())
                    .then(body => body.response.result.Answer.map(entry => entry.RDATA.CharacterStrings[0]));

            const found = await reports('ads.doubleclick.net');
            assert.ok(found.length >= 1, 'the name is on no list');
            assert.match(found[0], /source=(block-list-zone|advanced-blocking-app)/);
            assert.match(found[0], /blockListUrl=/);

            // A name can be on more than one block list, and the lists that
            // carry it are not the same for every name.
            const counts = new Map();
            for (const domain of ['ads.doubleclick.net', 'telemetry.newrelic.com', 'profile.qualtrics.com']) {
                const on = await reports(domain);
                assert.ok(on.length >= 1, `${domain} is on no list`);
                assert.ok(on.length <= 3, `${domain} is on too many lists`);
                counts.set(domain, on.length);
            }
            assert.ok(new Set(counts.values()).size > 1, 'every name is on the same number of lists');

            // The same name is always on the same lists.
            const first = await reports('profile.qualtrics.com');
            const second = await reports('profile.qualtrics.com');
            assert.deepEqual(second, first);
        });
    });

    test.describe('cache', () => {
        test.it('answers with the records of the name that was asked for', async t => {
            const mock = await createTechnitiumServer({
                cache: {
                    names: {
                        'wikipedia.org': [
                            {
                                name: 'wikipedia.org',
                                type: 'MX',
                                ttl: '600 (10 mins)',
                                rData: { preference: 10, exchange: 'mail.wikipedia.org' },
                            },
                        ],
                        'www.wikipedia.org': [
                            { name: 'www.wikipedia.org', type: 'A', ttl: '300 (5 mins)', rData: { ipAddress: '93.184.216.34' } },
                        ],
                    },
                },
            }).start();
            t.after(() => mock.stop());

            const cache = domain =>
                fetch(`${mock.url}/api/cache/list?domain=${encodeURIComponent(domain)}&direction=down`)
                    .then(r => r.json())
                    .then(body => body.response);

            const held = await cache('www.wikipedia.org');
            assert.equal(held.domain, 'www.wikipedia.org');
            assert.deepEqual(held.zones, []);
            assert.equal(held.records.length, 1);
            assert.equal(held.records[0].name, 'www.wikipedia.org');
            assert.equal(held.records[0].type, 'A');
            assert.equal(held.records[0].rData.ipAddress, '93.184.216.34');

            // The zone it holds is answered with the zone under it.
            const zone = await cache('wikipedia.org');
            assert.equal(zone.domain, 'wikipedia.org');
            assert.deepEqual(zone.zones, ['www.wikipedia.org']);
            assert.equal(zone.records.length, 1);
            assert.equal(zone.records[0].type, 'MX');

            // A name it never cached has nothing to answer with.
            const missing = await cache('api.github.com');
            assert.deepEqual(missing, { domain: 'api.github.com', zones: [], records: [] });
        });

        test.it('walks into the one zone a name leads to and holds the record a cached lookup was answered with', async t => {
            // A zone that holds no record of its own and leads to one zone.
            const one = await createTechnitiumServer({
                cache: {
                    names: {
                        'www.wikipedia.org': [
                            { name: 'www.wikipedia.org', type: 'A', ttl: '300 (5 mins)', rData: { ipAddress: '93.184.216.34' } },
                        ],
                    },
                },
            }).start();
            t.after(() => one.stop());

            const body = await fetch(`${one.url}/api/cache/list?domain=wikipedia.org&direction=down`).then(r => r.json());

            assert.equal(body.response.domain, 'www.wikipedia.org');
            assert.deepEqual(body.response.zones, []);
            assert.equal(body.response.records.length, 1);

            const mock = await createTechnitiumServer().start();
            t.after(() => mock.stop());

            // A lookup that was answered from the cache was answered with a
            // record the cache holds, so the cache report of that name has a
            // record of that type in it.
            const logs = await fetch(`${mock.url}/api/logs/query?type=recent&limit=200`).then(r => r.json());
            const cached = logs.response.entries.filter(entry => entry.responseType === 'Cached');
            assert.ok(cached.length > 0, 'the log has no cached lookups');

            for (const entry of cached.slice(0, 25)) {
                const held = await fetch(`${mock.url}/api/cache/list?domain=${encodeURIComponent(entry.qname)}&direction=down`).then(r =>
                    r.json(),
                );
                const types = (held.response.records || []).map(record => record.type);
                assert.ok(types.includes(entry.qtype), `${entry.qname} ${entry.qtype} is not in the cache`);
            }
        });
    });

    test.describe('request record', () => {
        test.it('records what was asked for', async t => {
            const mock = await createTechnitiumServer().start();
            t.after(() => mock.stop());

            await getTopStats(configFor(mock), 'TopClients', 5);

            const request = mock.requests.find(r => r.path.includes('getTop'));
            assert.equal(request.query.statsType, 'TopClients');
            assert.equal(request.query.limit, '5');
        });
    });

    test.describe('overrides', () => {
        test.it('uses the answers a caller brings', async t => {
            const mock = await createTechnitiumServer({ dashboard: { mainChartData: {}, stats: { totalQueries: 7 } } }).start();
            t.after(() => mock.stop());

            const dash = await getDashboard(configFor(mock));

            assert.equal(dash.stats.totalQueries, 7);
        });

        test.it('fails the calls a caller asks it to fail', async t => {
            const mock = await createTechnitiumServer().start();
            t.after(() => mock.stop());
            mock.fail('/api/settings/get', 503);

            const response = await fetch(`${mock.url}/api/settings/get`);
            assert.equal(response.status, 503);
        });
    });
});
