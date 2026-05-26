'use strict';

const { getClusterState, getSessionInfo } = require('./technitium');

async function discoverNodes(primaryServer) {
    try {
        const state = await getClusterState(primaryServer);
        if (!state || !state.nodes) return null;
        return state;
    } catch {
        return null;
    }
}

async function probeServer(server) {
    try {
        const info = await getSessionInfo(server);
        return {
            ok: true,
            version: info?.dnsServerVersion || info?.version || 'unknown',
            name: info?.dnsServerDomain || server.name
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

module.exports = { discoverNodes, probeServer };
