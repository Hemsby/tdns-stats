// Tests for backend/src/poller.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Poller = require('../src/poller');
const technitium = require('../src/technitium');

const { mockTechnitium, makePoller } = require('./helpers/poller-fixture');
const { createTechnitiumServer } = require('./helpers/technitium-mock');
const { buildTechnitiumData } = require('./helpers/technitium-data-gen');
const { createTechnitiumCluster } = require('./helpers/technitium-cluster-mock');

const CLUSTER_KEY = '__cluster';

// The RTT history is pruned after an hour, so the bucket fixtures have to
// sit in the current minute.
const minute = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();

/** A row in the query log, the way a server sends it. */
function row(rowNumber, timestamp) {
    return {
        rowNumber,
        timestamp,
        clientIpAddress: '89.160.20.112',
        protocol: 'Udp',
        responseType: 'Recursive',
        responseRtt: 12,
        rcode: 'NoError',
        qname: 'www.wikipedia.org',
        qtype: 'A',
        qclass: 'IN',
        answer: 'A 194.36.144.42',
    };
}

/** An RTT sample, oldest first. */
function rttSample(values) {
    return values.map((rtt, i) => ({ t: `2026-01-01T00:00:0${i}Z`, rtt }));
}

/** A node that answered with one bucket of RTT samples. */
function node(name, sum, n) {
    return { status: 'fulfilled', value: { name, buckets: new Map([[minute, { sum, n }]]) } };
}

/** Give the poller the stats a server would have collected by now. */
function withStats(poller, name, stats) {
    poller.state.nodes = poller.state.nodes || {};
    poller.state.nodes[name] = { stats: { stats } };
}

const feedMessages = broadcasts => broadcasts.filter(b => b.type === 'feed');
const perfMessage = broadcasts => broadcasts.find(b => b.type === 'perf');

test.describe('backend/src/poller.js', () => {
    test.describe('feed cursor', () => {
        test.it('sends every row on the first poll and only the new ones after that', async () => {
            let entries = [row(3, '2026-01-01T00:00:02Z'), row(1, '2026-01-01T00:00:00Z'), row(2, '2026-01-01T00:00:01Z')];
            const tech = mockTechnitium({ getQueryLogs: async () => ({ entries }) });
            const { poller, broadcasts } = makePoller(tech);
            const server = { name: 'ns1' };

            await poller._pollOneFeed(server);

            const feed = feedMessages(broadcasts);
            assert.equal(feed.length, 1);
            assert.equal(feed[0].cursorReset, false);
            // Newest first, whatever order the log came in.
            assert.deepEqual(
                feed[0].data.map(e => e.rowNumber),
                [3, 2, 1],
            );

            entries = [row(3, '2026-01-01T00:00:02Z'), row(4, '2026-01-01T00:00:03Z')];
            await poller._pollOneFeed(server);

            assert.deepEqual(
                feedMessages(broadcasts)[1].data.map(e => e.rowNumber),
                [4],
            );
            assert.equal(feedMessages(broadcasts)[1].cursorReset, false);

            // Two rows that share a timestamp are ordered by their row number.
            entries = [row(5, '2026-01-01T00:00:04Z'), row(6, '2026-01-01T00:00:04Z')];
            await poller._pollOneFeed(server);

            assert.deepEqual(
                feedMessages(broadcasts)[2].data.map(e => e.rowNumber),
                [6, 5],
            );
        });

        test.it('resets when the log has rotated and drops a row it cannot read', async () => {
            let entries = [row(5, '2026-01-01T00:00:10Z')];
            const tech = mockTechnitium({ getQueryLogs: async () => ({ entries }) });
            const { poller, broadcasts } = makePoller(tech);
            const server = { name: 'ns1' };

            await poller._pollOneFeed(server);

            // The newest row is now older than the cursor: the log was truncated.
            entries = [row(1, '2026-01-01T00:00:01Z')];
            await poller._pollOneFeed(server);

            const feed = feedMessages(broadcasts);
            assert.equal(feed[1].cursorReset, true);
            assert.deepEqual(
                feed[1].data.map(e => e.rowNumber),
                [1],
            );

            // A row whose timestamp cannot be read is dropped.
            const broken = mockTechnitium({
                getQueryLogs: async () => ({ entries: [row(1, 'not a date'), row(2, '2026-01-01T00:00:00Z')] }),
            });
            const { poller: other, broadcasts: otherBroadcasts } = makePoller(broken);

            await other._pollOneFeed({ name: 'ns1' });

            assert.deepEqual(
                feedMessages(otherBroadcasts)[0].data.map(e => e.rowNumber),
                [2],
            );
        });
    });

    test.describe('top lists', () => {
        test.it('keeps the lists it could read when one of them fails', async () => {
            const tech = mockTechnitium({
                getTopStats: async (server, statsType) => {
                    if (statsType === 'TopBlockedDomains') throw new Error('the list could not be read');
                    return { topDomains: [{ name: 'www.google.com', hits: 3 }], topClients: [{ name: '10.0.0.1', hits: 2 }] };
                },
            });
            const { poller, broadcasts } = makePoller(tech);

            await poller._pollOneTop({ name: 'ns1' });

            const message = broadcasts.find(b => b.type === 'top');
            assert.deepEqual(message.data.domains, [{ name: 'www.google.com', hits: 3 }]);
            assert.deepEqual(message.data.clients, [{ name: '10.0.0.1', hits: 2 }]);
            assert.deepEqual(message.data.blocked, []);
        });

        test.it('asks for the lists of the range it is given', async () => {
            const asked = [];
            const tech = mockTechnitium({
                getTopStats: async (server, statsType, limit, rangeType) => {
                    asked.push({ statsType, rangeType });
                    return {};
                },
            });
            const { poller } = makePoller(tech);

            await poller._fetchRangeData('LastWeek', { name: 'ns1' }, false);

            assert.equal(asked.length, 3);
            assert.ok(asked.every(a => a.rangeType === 'LastWeek'));
        });
    });

    test.describe('range data', () => {
        test.it('asks every server for the range, and the cluster once', async () => {
            const asked = [];
            const tech = mockTechnitium({
                getDashboard: async (server, type) => {
                    asked.push({ server: server.name, type });
                    return { stats: {} };
                },
            });
            const { poller } = makePoller(tech, [{ name: 'ns1' }, { name: 'ns2' }]);
            poller.clusterServer = { name: 'cluster' };

            await poller._pollRangeData();

            assert.deepEqual(
                asked.map(a => a.server),
                ['ns1', 'ns2', 'cluster'],
            );
            assert.ok(asked.every(a => a.type === 'LastDay'));
        });
    });

    test.describe('performance percentiles', () => {
        test.it('reports the mean, the percentiles and the cache hit rate', async () => {
            let asked = 0;
            const tech = mockTechnitium({
                getRttSample: async (_server, limit) => {
                    asked = limit;
                    return rttSample([50, 10, 30, 20, 40]);
                },
            });
            const { poller, broadcasts } = makePoller(tech);
            withStats(poller, 'ns1', { totalRecursive: 3, totalCached: 1, cachedEntries: 7 });

            await poller._pollOnePerf({ name: 'ns1' });

            const perf = perfMessage(broadcasts).data;
            assert.equal(perf.rtt.mean, 30);
            assert.equal(perf.rtt.median, 30);
            assert.equal(perf.rtt.p95, 50);
            assert.equal(perf.rtt.p99, 50);
            assert.equal(perf.cache.hitRate, 25);
            assert.equal(perf.cache.entries, 7);
            // The sample is as big as the number of recursive queries.
            assert.equal(asked, 3);

            // A busy server does not cost a big read: the sample is capped.
            const busy = mockTechnitium({
                getRttSample: async (_server, limit) => {
                    asked = limit;
                    return [];
                },
            });
            const { poller: busyPoller } = makePoller(busy);
            withStats(busyPoller, 'ns1', { totalRecursive: 5000 });

            await busyPoller._pollOnePerf({ name: 'ns1' });

            assert.equal(asked, 500);
        });

        test.it('reports no performance for a server with no recursive queries', async () => {
            const tech = mockTechnitium({ getRttSample: async () => rttSample([10]) });
            const { poller, broadcasts } = makePoller(tech);
            withStats(poller, 'ns1', { totalRecursive: 0 });

            await poller._pollOnePerf({ name: 'ns1' });

            assert.equal(perfMessage(broadcasts).data, null);
            assert.equal(poller.state.perf.ns1, undefined);
        });
    });

    test.describe('cluster RTT weighting', () => {
        test.it('weights the cluster mean by the number of samples', () => {
            const { poller } = makePoller(mockTechnitium());
            poller.clusterServer = { name: 'ns1', url: 'http://ns1.home.arpa' };

            // One node saw a single 10ms sample, the other saw three 20ms samples.
            // Pooling the sums gives 70/4 = 17.5, not (10 + 20) / 2 = 15.
            poller._updateClusterRtt([node('ns1', 10, 1), node('ns2', 60, 3)]);

            const series = poller.getState().rttSeries[CLUSTER_KEY];
            assert.equal(series.length, 1);
            assert.equal(series[0].mean, 17.5);
        });

        test.it('leaves a node that failed out of the cluster mean', () => {
            const { poller } = makePoller(mockTechnitium());
            poller.clusterServer = { name: 'ns1', url: 'http://ns1.home.arpa' };

            poller._updateClusterRtt([node('ns1', 10, 1), { status: 'rejected', reason: new Error('down') }]);

            assert.equal(poller.getState().rttSeries[CLUSTER_KEY][0].mean, 10);
        });
    });

    test.describe('cluster aggregate', () => {
        test.it('collects every node of a cluster and the state of each', async t => {
            const cluster = await createTechnitiumCluster({ seed: 3, count: 3 });
            t.after(() => cluster.stop());

            const servers = [0, 1, 2].map(index => cluster.serverConfig(index));
            const poller = new Poller(servers, () => {}, {}, technitium);

            await poller._pollStats();

            const aggregate = poller.state.nodes[CLUSTER_KEY];
            assert.equal(aggregate.clusterDomain, cluster.domain);
            assert.equal(aggregate.clusterNodes.length, 3);

            const names = aggregate.clusterNodes.map(node => node.name).sort();
            assert.deepEqual(names, ['ns1.cluster.home.arpa', 'ns2.cluster.home.arpa', 'ns3.cluster.home.arpa']);

            // The first node is the primary and the rest are secondaries.
            const primary = aggregate.clusterNodes.find(node => node.type === 'Primary');
            assert.equal(primary.name, 'ns1.cluster.home.arpa');

            // Every node reports when it last synced its configuration.
            for (const node of aggregate.clusterNodes) {
                assert.ok(node.configLastSynced, `${node.name} has no configLastSynced`);
            }
        });

        test.it('keeps the cluster out of the way when no node runs a cluster', async t => {
            const cluster = await createTechnitiumCluster({ seed: 4, count: 2 });
            t.after(() => cluster.stop());

            // A lone node that does not take part in a cluster.
            const solo = await createTechnitiumServer(buildTechnitiumData({ seed: 9, name: 'solo.home.arpa' })).start();
            t.after(() => solo.stop());

            const poller = new Poller([{ name: 'solo', url: solo.url, token: 'test-token' }], () => {}, {}, technitium);

            await poller._pollStats();

            assert.equal(poller.state.nodes[CLUSTER_KEY], undefined);
            assert.equal(poller.clusterServer, null);
            assert.ok(poller.state.nodes.solo);
        });
    });

    test.describe('cluster election', () => {
        test.it('elects the first node that runs a cluster and keeps that node', async () => {
            // ns1 does not run a cluster, ns2 does.
            const tech = mockTechnitium({
                getSessionInfo: async server => ({
                    version: '15.6.2',
                    dnsServerDomain: server.name + '.home.arpa',
                    clusterInitialized: server.name === 'ns2',
                }),
                getClusterState: async () => ({ clusterDomain: 'cluster.home.arpa', clusterNodes: [] }),
            });
            const servers = [
                { name: 'ns1', url: 'http://ns1.home.arpa' },
                { name: 'ns2', url: 'http://ns2.home.arpa' },
            ];
            const { poller } = makePoller(tech, servers);

            await poller._pollStats();

            assert.equal(poller.clusterServer.name, 'ns2');
            assert.ok(poller.state.nodes[CLUSTER_KEY]);

            // The election is not made again: ns1 now claims a cluster too.
            tech.getSessionInfo = async server => ({
                version: '15.6.2',
                dnsServerDomain: server.name + '.home.arpa',
                clusterInitialized: true,
            });

            await poller._pollStats();

            assert.equal(poller.clusterServer.name, 'ns2');
        });

        test.it('gives up the election when the elected node stops answering', async () => {
            let clusterAnswers = true;
            const tech = mockTechnitium({
                getSessionInfo: async server => ({
                    version: '15.6.2',
                    dnsServerDomain: server.name + '.home.arpa',
                    clusterInitialized: true,
                }),
                getClusterState: async () => {
                    if (!clusterAnswers) throw new Error('the node stopped answering');
                    return { clusterDomain: 'cluster.home.arpa', clusterNodes: [] };
                },
            });
            const servers = [
                { name: 'ns1', url: 'http://ns1.home.arpa' },
                { name: 'ns2', url: 'http://ns2.home.arpa' },
            ];
            const { poller } = makePoller(tech, servers);

            await poller._pollStats();
            assert.equal(poller.clusterServer.name, 'ns1');

            // The elected node goes away: the cluster is dropped, and the stale
            // top list of the cluster is dropped with it.
            clusterAnswers = false;
            poller.state.top[CLUSTER_KEY] = { topDomains: [{ name: 'ads.doubleclick.net', hits: 4 }] };

            await poller._pollStats();

            assert.equal(poller.clusterServer, null);
            assert.equal(poller.state.top[CLUSTER_KEY], undefined);
            assert.equal(poller.state.nodes[CLUSTER_KEY], undefined);

            // The next poll elects a node again.
            clusterAnswers = true;

            await poller._pollStats();

            assert.equal(poller.clusterServer.name, 'ns1');
        });
    });

    test.describe('timers', () => {
        test.it('are cleared by a pause and armed again by a resume', async () => {
            const { poller } = makePoller(mockTechnitium());

            await poller.resume();
            assert.equal(poller._dashboardRunning, true);

            poller.pause();
            assert.equal(poller._dashboardRunning, false);

            await poller.resume();
            assert.equal(poller._dashboardRunning, true);

            poller.pause();
        });

        test.it('stay off when a pause overtakes a resume', async () => {
            const { poller } = makePoller(mockTechnitium());

            const resuming = poller.resume();
            poller.pause();
            await resuming;

            assert.equal(poller._dashboardRunning, false);
        });
    });
});
