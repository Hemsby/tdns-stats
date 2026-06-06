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
        const preferred = normalizeAppName(preferredName);
        let fallback = null;
        for (const app of res.apps || []) {
            for (const da of app.dnsApps || []) {
                if (!da.isQueryLogs) continue;
                const found = { name: app.name, classPath: da.classPath };
                if (!fallback) fallback = found;
                if (!preferred || normalizeAppName(app.name) === preferred || queryLogAppTypeMatches(app.name, preferred)) return found;
            }
        }
        return preferred ? null : fallback;
    } catch (_) { /* no app or unreachable */ }
    return null;
}

function normalizeAppName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function queryLogAppTypeMatches(appName, preferred) {
    const actual = normalizeAppName(appName);
    for (const type of ['mysql', 'mariadb', 'postgresql', 'postgres', 'sqlite', 'sql server']) {
        if (preferred.includes(type) && actual.includes(type)) return true;
    }
    return false;
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

async function listCache(server, domain) {
    return apiGet(server, 'api/cache/list?domain=' + encodeURIComponent(domain) + '&direction=down');
}

async function dnsClientResolve(server, domain, type, protocol = 'UDP') {
    const path = 'api/dnsClient/resolve?server=this-server&domain=' + encodeURIComponent(domain) + '&type=' + encodeURIComponent(type) + '&protocol=' + encodeURIComponent(protocol);
    console.debug('[dnsClientResolve] url=' + server.url + '/' + path + ' server=' + server.name + ' type=' + type);
    return apiGet(server, path);
}

function isRecordLike(item) {
    return item && typeof item === 'object' && ('type' in item || 'recordType' in item || 'dnsResourceRecordType' in item || 'address' in item || 'value' in item || 'data' in item || 'text' in item || 'rdata' in item);
}

function extractDnsClientRecords(response) {
    if (!response) return [];
    const out = [];

    if (Array.isArray(response.records)) out.push(...response.records);
    if (Array.isArray(response.responseRecords)) out.push(...response.responseRecords);
    if (Array.isArray(response.answers)) out.push(...response.answers);
    if (Array.isArray(response.answer)) out.push(...response.answer);
    if (Array.isArray(response.rawResponses)) response.rawResponses.forEach(r => out.push(...extractDnsClientRecords(r)));
    if (Array.isArray(response.Answer)) out.push(...response.Answer);
    if (Array.isArray(response.Authority)) out.push(...response.Authority);
    if (Array.isArray(response.Additional)) out.push(...response.Additional);

    if (response.record) out.push(response.record);
    if (response.rdata) out.push(response.rdata);

    if (out.length) return out.filter(isRecordLike);
    if (isRecordLike(response)) return [response];

    return [];
}

function collectStringValues(obj, output = []) {
    if (obj == null) return output;
    if (typeof obj === 'string') {
        output.push(obj);
        return output;
    }
    if (typeof obj !== 'object') return output;
    if (Array.isArray(obj)) {
        for (const item of obj) collectStringValues(item, output);
        return output;
    }
    for (const [key, value] of Object.entries(obj)) {
        if (/extra(text)?/i.test(key) && typeof value === 'string') {
            if (/[=;:]/.test(value)) {
                output.push(value);
            }
        } else if (typeof value === 'string' && /(source=|group=|blocklisturl=|blocklist=|domain=|reason=)/i.test(value)) {
            output.push(value);
        } else if (typeof value === 'object') {
            collectStringValues(value, output);
        }
    }
    return output;
}

function normalizeExtraKey(key) {
    return String(key || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseDnsClientExtraText(value) {
    if (!value) return {};
    const raw = String(value);
    const lines = raw.split(/[;\n]+/).map(v => v.trim()).filter(Boolean);
    const out = {};
    let pendingKey = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const hasEquals = line.includes('=');
        const hasColon = !hasEquals && line.includes(':');
        if (pendingKey && !hasEquals && !hasColon) {
            out[pendingKey] = line;
            pendingKey = null;
            continue;
        }

        const sep = hasEquals ? '=' : ':';
        const [keyPart, ...rest] = line.split(sep).map(p => p.trim());
        const key = normalizeExtraKey(keyPart);
        const valuePart = rest.join(sep).trim();

        if (!key) continue;
        if (!valuePart) {
            pendingKey = key;
            continue;
        }

        out[key] = valuePart;
    }

    return out;
}

async function resolveBlockedDomain(server, domain) {
    const [aResult, aaaaResult] = await Promise.allSettled([
        dnsClientResolve(server, domain, 'A'),
        dnsClientResolve(server, domain, 'AAAA'),
    ]);

    const responses = [];
    const extras = [];
    const errors = [];

    for (const result of [aResult, aaaaResult]) {
        if (result.status === 'fulfilled') {
            console.debug('[resolveBlockedDomain] response', { domain, server: server.name, data: result.value });
            responses.push(result.value);
            extras.push(...collectStringValues(result.value));
        } else {
            console.debug('[resolveBlockedDomain] error', { domain, server: server.name, error: result.reason });
            errors.push(result.reason?.message || String(result.reason));
        }
    }

    const extraStrings = [...new Set(extras
        .filter(Boolean)
        .map(value => String(value).trim())
        .filter(Boolean))];
    const extraText = extraStrings.join('; ');
    const parsedEntries = extraStrings.map(text => ({ ...parseDnsClientExtraText(text), raw: text }));
    const parsed = parsedEntries[0] || {};

    return {
        responses,
        records: responses.flatMap(extractDnsClientRecords),
        extraText,
        parsed,
        parsedEntries,
        group: parsed.group || parsed['blocked group'] || parsed.block || parsed.filter || undefined,
        source: parsed.source || parsed['blocked source'] || parsed.provider || undefined,
        error: errors.length ? errors.join(' | ') : null,
    };
}

module.exports = { getSessionInfo, getDashboard, getSettings, getClusterState, listQueryLogApps, discoverQueryLogsApp, getQueryLogs, getRttSample, getCacheMaxEntries, getTopStats, listCache, resolveBlockedDomain };
