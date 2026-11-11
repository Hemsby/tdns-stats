'use strict';

/**
 * A stand-in for the technitium module.
 *
 * The poller takes the module as a dependency, so the polling logic can be
 * driven without any HTTP. Every method returns an empty result unless the
 * test overrides it.
 */

const Poller = require('../../src/poller');

function mockTechnitium(overrides = {}) {
    return {
        getDashboard: async () => ({ stats: { totalRecursive: 0, totalCached: 0, cachedEntries: 0 } }),
        getTopStats: async () => ({}),
        getQueryLogs: async () => ({ entries: [] }),
        getRttSample: async () => [],
        getSessionInfo: async () => ({ version: '15.6.2', dnsServerDomain: 'ns1.home.arpa' }),
        getClusterState: async () => ({}),
        getClusterNodeState: async () => ({}),
        certVerificationHint: () => '',
        ...overrides,
    };
}

/**
 * A poller wired to a mock Technitium, and the broadcasts it made.
 *
 * The timers are never started, so a test that only polls once has nothing to
 * clean up.
 */
function makePoller(tech, servers = [{ name: 'ns1', url: 'http://ns1.home.arpa' }]) {
    const broadcasts = [];
    const poller = new Poller(servers, msg => broadcasts.push(msg), {}, tech);
    return { poller, broadcasts };
}

module.exports = { mockTechnitium, makePoller };
