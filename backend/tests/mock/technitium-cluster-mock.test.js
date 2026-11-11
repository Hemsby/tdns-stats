// Tests for backend/tests/helpers/technitium-cluster-mock.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTechnitiumCluster } = require('../helpers/technitium-cluster-mock');
const { getClusterState, getDashboard, getTopStats } = require('../../src/technitium');

const COUNTERS = [
    'totalQueries',
    'totalNoError',
    'totalServerFailure',
    'totalNxDomain',
    'totalRefused',
    'totalAuthoritative',
    'totalRecursive',
    'totalCached',
    'totalBlocked',
    'totalDropped',
    'totalClients',
];

test.describe('backend/tests/helpers/technitium-cluster-mock.js', () => {
    test.describe('cluster', () => {
        test.it('runs one server per node and reports every node from every node', async t => {
            const cluster = await createTechnitiumCluster({ seed: 1, count: 3 });
            t.after(() => cluster.stop());

            assert.equal(cluster.servers.length, 3);
            const urls = cluster.servers.map(server => server.url);
            assert.equal(new Set(urls).size, 3, 'two nodes share a URL');

            for (let index = 0; index < cluster.servers.length; index++) {
                const state = await getClusterState(cluster.serverConfig(index));
                assert.equal(state.clusterDomain, cluster.domain);
                assert.equal(state.clusterNodes.length, 3);

                // Every node is reachable at its own URL.
                for (const node of state.clusterNodes) assert.ok(node.url.startsWith('http://'));

                // A node is Self, the others are Connected.
                const self = state.clusterNodes.find(node => node.name === cluster.nodes[index].name);
                const others = state.clusterNodes.filter(node => node.name !== cluster.nodes[index].name);
                assert.equal(self.state, 'Self');
                for (const node of others) assert.equal(node.state, 'Connected');
            }

            // The first node is the primary and the rest are secondaries.
            const types = (await getClusterState(cluster.serverConfig(0))).clusterNodes.map(node => node.type);
            assert.equal(types.filter(type => type === 'Primary').length, 1);
            assert.equal(types.filter(type => type === 'Secondary').length, 2);
        });

        test.it('gives every node its own numbers and its own mix of answers', async t => {
            const cluster = await createTechnitiumCluster({ seed: 1, count: 3 });
            t.after(() => cluster.stop());

            const stats = [];
            const shares = [];
            for (const server of cluster.servers) {
                const body = await fetch(`${server.url}/api/dashboard/stats/get`).then(r => r.json());
                stats.push(body.response.stats);
                shares.push(body.response.stats.totalCached / body.response.stats.totalQueries);
            }

            for (const first of stats) {
                for (const second of stats) {
                    if (first === second) continue;
                    assert.notDeepEqual(first, second, 'two nodes have the same numbers');
                }
            }

            assert.ok(new Set(shares.map(share => share.toFixed(2))).size > 1, 'the nodes answer the same way');
        });
    });

    test.describe('cluster totals', () => {
        test.it('counts the traffic of every node', async t => {
            const cluster = await createTechnitiumCluster({ seed: 7, count: 3 });
            t.after(() => cluster.stop());

            const totals = await getDashboard(cluster.serverConfig(0), 'LastHour', 'cluster');
            const own = await getDashboard(cluster.serverConfig(0), 'LastHour');

            for (const counter of COUNTERS) {
                const expected = cluster.servers.reduce((sum, server) => sum + server.state.dashboard.stats[counter], 0);
                assert.equal(totals.stats[counter], expected, counter);
            }

            // The cluster carries more traffic than any one node.
            assert.ok(totals.stats.totalQueries > own.stats.totalQueries);
            for (const server of cluster.servers) {
                assert.ok(totals.stats.totalQueries > server.state.dashboard.stats.totalQueries);
            }

            // The chart of the cluster is the sum of the charts of the nodes.
            for (const dataset of totals.mainChartData.datasets) {
                const expected = cluster.servers.reduce((sum, server) => {
                    const node = server.state.dashboard.mainChartData.datasets.find(d => d.label === dataset.label);
                    return sum + node.data.reduce((a, b) => a + b, 0);
                }, 0);
                const got = dataset.data.reduce((a, b) => a + b, 0);
                assert.equal(got, expected, dataset.label);
            }
        });

        test.it('adds up the top lists of every node and answers for one node by name', async t => {
            const cluster = await createTechnitiumCluster({ seed: 7, count: 3 });
            t.after(() => cluster.stop());

            for (const [statsType, key] of [
                ['TopDomains', 'topDomains'],
                ['TopBlockedDomains', 'topBlockedDomains'],
                ['TopClients', 'topClients'],
            ]) {
                const totals = await getTopStats(cluster.serverConfig(0), statsType, 100, 'LastHour', 'cluster');
                const rows = totals[key] || [];

                const expected = new Map();
                for (const server of cluster.servers) {
                    for (const row of server.state.topStats[statsType][key] || []) {
                        expected.set(row.name, (expected.get(row.name) || 0) + row.hits);
                    }
                }

                assert.equal(rows.length, expected.size, statsType);
                for (const row of rows) {
                    assert.equal(row.hits, expected.get(row.name), `${statsType}: ${row.name}`);
                }
                // The rows are ranked by their hits, so the biggest is first.
                const hits = rows.map(row => row.hits);
                assert.deepEqual(
                    hits,
                    [...hits].sort((a, b) => b - a),
                    statsType,
                );
            }

            // A node asked for by name answers with its own numbers.
            const totals = await getDashboard(cluster.serverConfig(0), 'LastHour', 'cluster');
            const byName = await getDashboard(cluster.serverConfig(0), 'LastHour', cluster.nodes[1].name);
            const own = cluster.servers[1].state.dashboard;

            assert.equal(byName.stats.totalQueries, own.stats.totalQueries);
            assert.notEqual(byName.stats.totalQueries, totals.stats.totalQueries);
        });
    });
});
