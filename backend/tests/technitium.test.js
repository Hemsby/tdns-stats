// Tests for backend/src/technitium.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTechnitiumServer } = require('./helpers/technitium-mock');
const {
    getSessionInfo,
    getDashboard,
    getTopStats,
    getSettings,
    getCacheMaxEntries,
    getQueryLogs,
    getRttSample,
    getClusterNodeState,
    listQueryLogApps,
    discoverQueryLogsApp,
    certVerificationHint,
    __setFetch,
    __resetState,
} = require('../src/technitium');

/** A server with a query log app, which is what the query log needs. */
function serverWithLog(fake, name = 'ns1') {
    return fake.serverConfig(name, {
        queryLogsApp: { name: 'Query Logs (Sqlite)', classPath: 'QueryLogsSqlite.App' },
    });
}

test.describe('backend/src/technitium.js', () => {
    test.describe('transport', () => {
        test.it('sends the server token as a bearer header', async t => {
            const fake = await createTechnitiumServer({
                info: {
                    version: '15.6.2',
                },
            }).start();
            t.after(() => fake.stop());

            await getSessionInfo(fake.serverConfig('ns1', { token: 'secret-token' }));

            const req = fake.requests.find(r => r.path === '/api/user/session/get');
            assert.equal(req.headers.authorization, 'Bearer secret-token');
        });

        test.it('reports the failure the server gives', async t => {
            const fake = await createTechnitiumServer().start();
            t.after(() => fake.stop());

            fake.fail('/api/settings/get', 500);

            await assert.rejects(() => getSettings(fake.serverConfig()), /500/);

            // Technitium answers 200 with status 'error' when the API itself refuses.
            fake.state.fail['/api/settings/get'] = {
                status: 200,
                body: { status: 'error', errorMessage: 'Invalid token' },
            };

            await assert.rejects(() => getSettings(fake.serverConfig()), /Invalid token/);
        });
    });

    test.describe('session', () => {
        test.it('reads the fields the dashboard needs', async t => {
            const fake = await createTechnitiumServer({
                info: {
                    version: '15.6.2',
                    dnsServerDomain: 'ns1.home.arpa',
                    clusterInitialized: true,
                    clusterDomain: 'cluster.home.arpa',
                    clusterNodes: [{ name: 'ns1.home.arpa' }],
                },
            }).start();
            t.after(() => fake.stop());

            const info = await getSessionInfo(fake.serverConfig());

            assert.equal(info.version, '15.6.2');
            assert.equal(info.dnsServerDomain, 'ns1.home.arpa');
            assert.equal(info.clusterInitialized, true);
            assert.equal(info.clusterDomain, 'cluster.home.arpa');
            assert.equal(info.clusterNodes.length, 1);
        });

        test.it('says a server that is not in a cluster is not clustered', async t => {
            const fake = await createTechnitiumServer({ info: { version: '15.6.2' } }).start();
            t.after(() => fake.stop());

            const info = await getSessionInfo(fake.serverConfig());

            assert.equal(info.clusterInitialized, false);
            assert.equal(info.clusterDomain, null);
        });
    });

    test.describe('dashboard', () => {
        test.it('takes the chart labels from our clock, not from the server', async t => {
            const stale = ['2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z'];
            const fake = await createTechnitiumServer({
                dashboard: { mainChartData: { labels: stale, datasets: [] } },
            }).start();
            t.after(() => fake.stop());

            const data = await getDashboard(fake.serverConfig(), 'LastHour');

            assert.equal(data.mainChartData.labels.length, 2);
            assert.equal(data.mainChartData.labelFormat, 'HH:mm');
            assert.notDeepEqual(data.mainChartData.labels, stale);

            // One label per minute, one after the other.
            const minutes = data.mainChartData.labels.map(label => new Date(label).getUTCMinutes());
            assert.equal(minutes[1] - minutes[0], 1);

            // The longer ranges are shown in days and in months.
            const week = await getDashboard(fake.serverConfig(), 'LastWeek');
            const year = await getDashboard(fake.serverConfig(), 'LastYear');

            assert.equal(week.mainChartData.labelFormat, 'dd/MM');
            assert.equal(year.mainChartData.labelFormat, 'MM/yyyy');
            // The days are the start of the day, and the months the first of
            // the month, both in UTC.
            assert.equal(new Date(week.mainChartData.labels[0]).getUTCHours(), 0);
            assert.equal(new Date(year.mainChartData.labels[0]).getUTCDate(), 1);

            // The cluster is asked for by name.
            await getDashboard(fake.serverConfig(), 'LastHour', 'cluster');

            const req = fake.requests.filter(r => r.path === '/api/dashboard/stats/get').pop();
            assert.equal(req.query.node, 'cluster');
        });

        test.it('reports the failure the server gives', async t => {
            const fake = await createTechnitiumServer().start();
            t.after(() => fake.stop());

            fake.fail('/api/dashboard/stats/get', 500);

            await assert.rejects(() => getDashboard(fake.serverConfig(), 'LastHour'), /500/);
        });
    });

    test.describe('top lists', () => {
        test.it('asks for the named list with the row limit', async t => {
            const fake = await createTechnitiumServer({
                topStats: { TopDomains: { topDomains: [{ name: 'www.wikipedia.org', hits: 42 }] } },
            }).start();
            t.after(() => fake.stop());

            await getTopStats(fake.serverConfig(), 'TopDomains', 25, 'LastHour');

            const req = fake.requests.find(r => r.path === '/api/dashboard/stats/getTop');
            assert.equal(req.query.statsType, 'TopDomains');
            assert.equal(req.query.limit, '25');
            assert.equal(req.query.type, 'LastHour');
        });

        test.it('reports the failure the server gives', async t => {
            const fake = await createTechnitiumServer().start();
            t.after(() => fake.stop());

            fake.fail('/api/dashboard/stats/getTop', 500);

            await assert.rejects(() => getTopStats(fake.serverConfig(), 'TopDomains', 25, 'LastHour'), /500/);
        });
    });

    test.describe('app discovery', () => {
        // The apps a real server lists, with the names and the class paths it
        // uses (Technitium v15.6.2).
        const SQLITE_APP = {
            name: 'Query Logs (Sqlite)',
            version: '9.1.3',
            dnsApps: [{ classPath: 'QueryLogsSqlite.App', isQueryLogger: true, isQueryLogs: true }],
        };
        const MYSQL_APP = {
            name: 'Query Logs (MySQL)',
            version: '4.2',
            dnsApps: [{ classPath: 'QueryLogsMySql.App', isQueryLogger: true, isQueryLogs: true }],
        };
        const PG_APP = {
            name: 'Query Logs (PostgreSQL)',
            version: '1.3',
            dnsApps: [{ classPath: 'QueryLogsPostgreSql.App', isQueryLogger: true, isQueryLogs: true }],
        };
        const BLOCKING_APP = {
            name: 'Advanced Blocking',
            version: '11.2',
            dnsApps: [{ classPath: 'AdvancedBlocking.App', isRequestBlockingHandler: true }],
        };

        test.it('returns the app it was asked for', async t => {
            const fake = await createTechnitiumServer({ apps: [SQLITE_APP, MYSQL_APP, PG_APP] }).start();
            t.after(() => fake.stop());

            const asked = await discoverQueryLogsApp(fake.serverConfig(), 'Query Logs (PostgreSQL)');
            const byType = await discoverQueryLogsApp(fake.serverConfig(), 'sqlite');
            const first = await discoverQueryLogsApp(fake.serverConfig(), null);

            assert.equal(asked.name, 'Query Logs (PostgreSQL)');
            assert.equal(asked.classPath, 'QueryLogsPostgreSql.App');
            assert.equal(byType.name, 'Query Logs (Sqlite)');
            assert.equal(byType.classPath, 'QueryLogsSqlite.App');
            // The server lists its apps by name, so the first one is the MySQL one.
            assert.equal(first.name, 'Query Logs (MySQL)');
        });

        test.it('reports nothing when the requested app is not installed', async t => {
            const fake = await createTechnitiumServer({ apps: [MYSQL_APP] }).start();
            t.after(() => fake.stop());

            const found = await discoverQueryLogsApp(fake.serverConfig(), 'Query Logs (PostgreSQL)');

            assert.equal(found, null);
        });

        test.it('lists the apps that log queries', async t => {
            const fake = await createTechnitiumServer({ apps: [BLOCKING_APP, SQLITE_APP] }).start();
            t.after(() => fake.stop());

            const apps = await listQueryLogApps(fake.serverConfig());

            assert.deepEqual(apps, ['Query Logs (Sqlite)']);
        });

        test.it('lists no apps when the server has none', async t => {
            const fake = await createTechnitiumServer({ apps: [BLOCKING_APP] }).start();
            t.after(() => fake.stop());

            const apps = await listQueryLogApps(fake.serverConfig());

            assert.deepEqual(apps, []);
        });
    });

    test.describe('query log', () => {
        test.it('is asked for newest entries first', async t => {
            const fake = await createTechnitiumServer({
                logEntries: [{ timestamp: '2026-01-01T00:00:00Z', rowNumber: 1, responseType: 'Recursive', responseRtt: 12 }],
            }).start();
            t.after(() => fake.stop());

            const logs = await getQueryLogs(serverWithLog(fake), 20);

            assert.equal(logs.entries.length, 1);
            const req = fake.requests.find(r => r.path === '/api/logs/query');
            assert.equal(req.query.name, 'Query Logs (Sqlite)');
            assert.equal(req.query.entriesPerPage, '20');
            assert.equal(req.query.descendingOrder, 'true');
        });

        test.it('is not read when the server has no query log app', async t => {
            const fake = await createTechnitiumServer().start();
            t.after(() => fake.stop());

            assert.equal(await getQueryLogs(fake.serverConfig(), 20), null);
        });
    });

    test.describe('RTT sample', () => {
        test.it('keeps only the entries with a numeric RTT', async t => {
            const fake = await createTechnitiumServer({
                logEntries: [
                    { timestamp: '2026-01-01T00:00:00Z', rowNumber: 1, responseType: 'Recursive', responseRtt: 12 },
                    { timestamp: '2026-01-01T00:00:01Z', rowNumber: 2, responseType: 'Recursive', responseRtt: 'nope' },
                    { timestamp: '2026-01-01T00:00:02Z', rowNumber: 3, responseType: 'Recursive' },
                ],
            }).start();
            t.after(() => fake.stop());

            const sample = await getRttSample(serverWithLog(fake), 50);

            assert.deepEqual(sample, [{ t: '2026-01-01T00:00:00Z', rtt: 12 }]);

            // Only the recursive rows are asked for.
            const req = fake.requests.find(r => r.path === '/api/logs/query');
            assert.equal(req.query.responseType, 'Recursive');
        });

        test.it('gives an empty sample when the server has no query log app', async t => {
            const fake = await createTechnitiumServer().start();
            t.after(() => fake.stop());

            assert.deepEqual(await getRttSample(fake.serverConfig(), 20), []);
        });
    });

    test.describe('TLS certificates', () => {
        test.beforeEach(() => __resetState());
        test.afterEach(() => __setFetch(null));

        test.it('falls back to an unverified connection when the certificate cannot be verified', async () => {
            const calls = [];
            __setFetch(async (url, options) => {
                calls.push(options);
                if (calls.length === 1) {
                    // The certificate of a cluster peer that is not trusted.
                    const err = new Error('self signed certificate');
                    err.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
                    throw err;
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        status: 'ok',
                        response: { clusterDomain: 'cluster.home.arpa', clusterNodes: [{ id: 'node-1', name: 'ns1.cluster.home.arpa' }] },
                    }),
                };
            });

            const state = await getClusterNodeState({ name: 'ns1', url: 'https://ns1.cluster.home.arpa:5380', token: 't' });

            assert.equal(state.clusterDomain, 'cluster.home.arpa');
            // The first attempt verified the certificate; the second did not.
            assert.equal(calls.length, 2);
            assert.equal(calls[0].agent.options.rejectUnauthorized, undefined);
            assert.equal(calls[1].agent.options.rejectUnauthorized, false);

            // The host is remembered, so the next poll does not try to verify it again.
            await getClusterNodeState({ name: 'ns1', url: 'https://ns1.cluster.home.arpa:5380', token: 't' });

            assert.equal(calls.length, 3);
            assert.equal(calls[2].agent.options.rejectUnauthorized, false);

            // The operator is told how to trust the certificate instead.
        });

        test.it('does not fall back when the failure is not about the certificate', async () => {
            let calls = 0;
            __setFetch(async () => {
                calls++;
                // The node is unreachable, so an unverified connection would not help.
                const err = new Error('connect ECONNREFUSED 192.168.1.10:5380');
                err.code = 'ECONNREFUSED';
                throw err;
            });

            await assert.rejects(
                () => getClusterNodeState({ name: 'ns1', url: 'https://ns1.cluster.home.arpa:5380', token: 't' }),
                /ECONNREFUSED/,
            );

            assert.equal(calls, 1);
        });
    });

    test.describe('certificate hint', () => {
        test.it('says how to trust the certificate', () => {
            const err = new Error('self signed certificate');
            err.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';

            const hint = certVerificationHint(err);

            assert.match(hint, /ignoreSsl/);
            assert.match(hint, /NODE_EXTRA_CA_CERTS/);
        });

        test.it('says nothing when the failure is not about the certificate', () => {
            const err = new Error('connect ECONNREFUSED 192.168.1.10:5380');
            err.code = 'ECONNREFUSED';

            assert.equal(certVerificationHint(err), '');
            assert.equal(certVerificationHint(null), '');
        });
    });

    test.describe('response body', () => {
        test.afterEach(() => __setFetch(null));

        test.it('reads the body again when the connection dropped after the headers', async () => {
            let calls = 0;
            __setFetch(async () => {
                calls++;
                if (calls === 1) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => {
                            // The pooled socket was closed while the body was read.
                            const err = new Error('Premature close');
                            err.type = 'system';
                            throw err;
                        },
                    };
                }
                return { ok: true, status: 200, json: async () => ({ status: 'ok', response: { cacheMaximumEntries: 4096 } }) };
            });

            const settings = await getSettings({ name: 'ns1', url: 'http://ns1.home.arpa:5380', token: 't' });

            assert.equal(settings.cacheMaximumEntries, 4096);
            assert.equal(calls, 2);
        });

        test.it('does not read the body again when the answer is not JSON', async () => {
            let calls = 0;
            __setFetch(async () => {
                calls++;
                return {
                    ok: true,
                    status: 200,
                    json: async () => {
                        throw new SyntaxError('Unexpected token < in JSON at position 0');
                    },
                };
            });

            await assert.rejects(() => getSettings({ name: 'ns1', url: 'http://ns1.home.arpa:5380', token: 't' }), /Unexpected token/);

            assert.equal(calls, 1);
        });
    });

    test.describe('cache limit', () => {
        test.it('reports the cache limit the server gives', async t => {
            const fake = await createTechnitiumServer({ settings: { cacheMaximumEntries: 4096 } }).start();
            t.after(() => fake.stop());

            assert.equal(await getCacheMaxEntries(fake.serverConfig()), 4096);
        });

        test.it('reports a limit of zero when the settings cannot be read', async t => {
            const fake = await createTechnitiumServer().start();
            t.after(() => fake.stop());

            fake.fail('/api/settings/get', 500);

            assert.equal(await getCacheMaxEntries(fake.serverConfig()), 0);
        });
    });
});
