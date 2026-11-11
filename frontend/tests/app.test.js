// Tests for frontend/js/app.js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    serverNamesOf,
    isClusterState,
    defaultTabFor,
    isAggregateTab,
    effectiveTopServer,
    queryLogStatusOf,
    rangeCacheKey,
    viewerCount,
} from '../js/app.js';
import { CLUSTER_KEY, FOLLOW_CHART_KEY } from '../js/helpers.js';

// The servers a real Technitium installation reports, with the cluster among them.
const NODES = {
    'ns1.home.arpa': {
        name: 'ns1.home.arpa',
        url: 'http://ns1.home.arpa:5380',
        version: '15.6.2',
        dnsServerDomain: 'ns1.home.arpa',
        clusterInitialized: true,
        queryLogsApp: 'Query Logs (Sqlite)',
        queryLogsAppName: 'Query Logs (Sqlite)',
    },
    'ns2.home.arpa': {
        name: 'ns2.home.arpa',
        url: 'http://ns2.home.arpa:5380',
        version: '15.6.2',
        dnsServerDomain: 'ns2.home.arpa',
        clusterInitialized: false,
        queryLogsApp: null,
        queryLogsAppName: 'Query Logs (Sqlite)',
        queryLogsLookupFailed: true,
    },
    [CLUSTER_KEY]: {
        clusterDomain: 'cluster.home.arpa',
        clusterNodes: [{ id: 'node-1', name: 'ns1.home.arpa' }],
    },
};

test.describe('frontend/js/app.js', () => {
    test.describe('server names', () => {
        test.it('names the servers without the cluster', () => {
            assert.deepEqual(serverNamesOf(NODES), ['ns1.home.arpa', 'ns2.home.arpa']);
            assert.deepEqual(serverNamesOf({ 'ns1.home.arpa': {} }), ['ns1.home.arpa']);
        });

        test.it('names no servers when the message names none', () => {
            assert.deepEqual(serverNamesOf({}), []);
            assert.deepEqual(serverNamesOf(null), []);
        });
    });

    test.describe('cluster state', () => {
        test.it('knows the message carries a cluster', () => {
            assert.equal(isClusterState(NODES), true);
        });

        test.it('knows there is no cluster when the message names none', () => {
            assert.equal(isClusterState({ 'ns1.home.arpa': {} }), false);
            assert.equal(isClusterState({}), false);
            assert.equal(isClusterState(null), false);
        });
    });

    test.describe('default tab', () => {
        test.it('opens on the cluster when there is one, and on the first server otherwise', () => {
            assert.equal(defaultTabFor(['ns1.home.arpa', 'ns2.home.arpa'], true), CLUSTER_KEY);
            assert.equal(defaultTabFor(['ns1.home.arpa'], false), 'ns1.home.arpa');
        });

        test.it('opens on nothing when there are no servers', () => {
            assert.equal(defaultTabFor([], false), null);
            assert.equal(defaultTabFor([], true), CLUSTER_KEY);
        });
    });

    test.describe('aggregate tab', () => {
        test.it('is the cluster or every server', () => {
            assert.equal(isAggregateTab(CLUSTER_KEY), true);
            assert.equal(isAggregateTab('all'), true);
        });

        test.it('is not a single server', () => {
            assert.equal(isAggregateTab('ns1.home.arpa'), false);
            assert.equal(isAggregateTab(null), false);
        });
    });

    test.describe('top list server', () => {
        test.it('is the chart while they follow it', () => {
            assert.equal(effectiveTopServer(FOLLOW_CHART_KEY, 'ns1.home.arpa'), 'ns1.home.arpa');
        });

        test.it('is the server they were pointed at otherwise', () => {
            assert.equal(effectiveTopServer('ns2.home.arpa', 'ns1.home.arpa'), 'ns2.home.arpa');
        });
    });

    test.describe('query log status', () => {
        test.it('says which app each server logs with', () => {
            const status = queryLogStatusOf(NODES);

            assert.equal(status['ns1.home.arpa'].queryLogsApp, 'Query Logs (Sqlite)');
            assert.equal(status['ns1.home.arpa'].queryLogsLookupFailed, false);
            // A server that was reached but whose app was never found says so.
            assert.equal(status['ns2.home.arpa'].queryLogsApp, null);
            assert.equal(status['ns2.home.arpa'].queryLogsAppName, 'Query Logs (Sqlite)');
            assert.equal(status['ns2.home.arpa'].queryLogsLookupFailed, true);
            // The cluster is not a server.
            assert.equal(status[CLUSTER_KEY], undefined);
        });

        test.it('says nothing about a server it has never heard of', () => {
            assert.deepEqual(queryLogStatusOf({}), {});
        });
    });

    test.describe('range key', () => {
        test.it('is the server and the range', () => {
            assert.equal(rangeCacheKey('ns1.home.arpa', 'LastWeek'), 'ns1.home.arpa:LastWeek');
        });

        test.it('tells two ranges of the same server apart', () => {
            assert.notEqual(rangeCacheKey('ns1.home.arpa', 'LastWeek'), rangeCacheKey('ns1.home.arpa', 'LastMonth'));
        });
    });

    test.describe('viewer count', () => {
        test.it('is the count the server sent', () => {
            assert.equal(viewerCount({ count: 7 }), 7);
            assert.equal(viewerCount({ count: 0 }), 0);
        });

        test.it('is never negative', () => {
            assert.equal(viewerCount({ count: -4 }), 0);
            assert.equal(viewerCount({}), 0);
            assert.equal(viewerCount(null), 0);
        });
    });
});
