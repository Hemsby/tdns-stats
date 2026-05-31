'use strict';

const fetch = require('node-fetch');
const https = require('https');

function makeAgent(server) {
    return server.ignoreSsl && server.url.startsWith('https')
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined;
}

function authHeaders(server) {
    return { 'Authorization': `Bearer ${server.token}` };
}

async function apiGet(server, path) {
    const url = `${server.url.replace(/\/$/, '')}/${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(url, {
            agent:   makeAgent(server),
            headers: authHeaders(server),
            signal:  controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.status !== 'ok') throw new Error(data.errorMessage || 'API error');
        return data.response;
    } finally {
        clearTimeout(timer);
    }
}

async function getSessionInfo(server) {
    const url = `${server.url.replace(/\/$/, '')}/api/user/session/get`;
    const res = await fetch(url, {
        agent:   makeAgent(server),
        headers: authHeaders(server),
        timeout: 8000
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.status !== 'ok') throw new Error(data.errorMessage || 'API error');
    return {
        version:            data.info?.version,
        dnsServerDomain:    data.info?.dnsServerDomain,
        clusterInitialized: data.info?.clusterInitialized || false,
        clusterDomain:      data.info?.clusterDomain || null,
        clusterNodes:       data.info?.clusterNodes  || null,
    };
}

async function getDashboard(server, type, node) {
    let path = 'api/dashboard/stats/get?type=' + (type || 'LastHour');
    if (node) path += '&node=' + encodeURIComponent(node);
    return apiGet(server, path);
}

async function getSettings(server) {
    return apiGet(server, 'api/settings/get');
}

async function getClusterState(server) {
    return apiGet(server, 'api/admin/cluster/state');
}

async function listQueryLogApps(server) {
    try {
        const res = await apiGet(server, 'api/apps/list');
        const found = [];
        for (const app of res.apps || []) {
            for (const da of app.dnsApps || []) {
                if (da.isQueryLogs) found.push(app.name);
            }
        }
        return found;
    } catch (_) { return []; }
}

async function discoverQueryLogsApp(server, preferredName) {
    try {
        const res = await apiGet(server, 'api/apps/list');
        for (const app of res.apps || []) {
            if (preferredName && app.name.toLowerCase() !== preferredName.toLowerCase()) continue;
            for (const da of app.dnsApps || []) {
                if (da.isQueryLogs) return { name: app.name, classPath: da.classPath };
            }
        }
    } catch (_) { /* no app or unreachable */ }
    return null;
}

async function getQueryLogs(server, limit) {
    if (!server.queryLogsApp) return null;
    const name = encodeURIComponent(server.queryLogsApp.name);
    const classPath = encodeURIComponent(server.queryLogsApp.classPath);
    return apiGet(server, 'api/logs/query?name=' + name + '&classPath=' + classPath + '&entriesPerPage=' + limit + '&descendingOrder=true');
}

async function getRttSample(server, limit) {
    if (!server.queryLogsApp) return [];
    const name = encodeURIComponent(server.queryLogsApp.name);
    const classPath = encodeURIComponent(server.queryLogsApp.classPath);
    const res = await apiGet(server, 'api/logs/query?name=' + name + '&classPath=' + classPath + '&entriesPerPage=' + limit + '&descendingOrder=true');
    return (res?.entries || [])
        .filter(e => e.responseType === 'Recursive' && typeof e.responseRtt === 'number')
        .map(e => e.responseRtt);
}

async function getCacheMaxEntries(server) {
    try {
        const res = await getSettings(server);
        return res?.cacheMaximumEntries ?? 0;
    } catch (_) { return 0; }
}

async function getTopStats(server, statsType, limit, type, node) {
    let path = 'api/dashboard/stats/getTop?type=' + (type || 'LastHour') + '&statsType=' + statsType + '&limit=' + limit;
    if (node) path += '&node=' + encodeURIComponent(node);
    return apiGet(server, path);
}

module.exports = { getSessionInfo, getDashboard, getSettings, getClusterState, listQueryLogApps, discoverQueryLogsApp, getQueryLogs, getRttSample, getCacheMaxEntries, getTopStats };
