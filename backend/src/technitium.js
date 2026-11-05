'use strict';

const fetch = require('node-fetch');
const http  = require('http');
const https = require('https');

const AGENT_OPTS = { keepAlive: true, maxSockets: 10, maxFreeSockets: 5 };
const _agentHttp     = new http.Agent(AGENT_OPTS);
const _agentHttps    = new https.Agent(AGENT_OPTS);
const _agentInsecure = new https.Agent({ ...AGENT_OPTS, rejectUnauthorized: false });

function makeAgent(server, opts) {
    if (!server.url.startsWith('https')) return _agentHttp;
    // forceInsecure is used by getClusterNodeState's verify-then-fallback below.
    if (opts?.forceInsecure) return _agentInsecure;
    return server.ignoreSsl ? _agentInsecure : _agentHttps;
}

function authHeaders(server) {
    return { 'Authorization': `Bearer ${server.token}` };
}

function makeNoKeepAliveAgent(server, opts) {
    if (!server.url.startsWith('https')) return new http.Agent({ keepAlive: false });
    return new https.Agent({ keepAlive: false, rejectUnauthorized: !(opts?.forceInsecure || server.ignoreSsl) });
}

// Defensive retry for a body that fails to read after the response headers
// already came back ok (e.g. a genuine transient connection drop on a pooled
// socket). Retries once on a fresh, non-pooled connection rather than failing
// the whole call on what's usually a one-off network hiccup.
async function readJsonBody(server, url, res, opts) {
    try {
        return await res.json();
    } catch (err) {
        if (err.type !== 'system') throw err;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
            const retryRes = await fetch(url, {
                agent:    makeNoKeepAliveAgent(server, opts),
                headers:  authHeaders(server),
                compress: false,
                signal:   controller.signal,
            });
            if (!retryRes.ok) throw new Error(`HTTP ${retryRes.status}`);
            return await retryRes.json();
        } finally {
            clearTimeout(timer);
        }
    }
}

async function fetchJson(server, url, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(url, {
            agent:    makeAgent(server, opts),
            headers:  authHeaders(server),
            // Technitium negotiates response compression (switching to chunked
            // transfer encoding) whenever Accept-Encoding is present, for both
            // success and error responses. node-fetch sends "gzip,deflate" by
            // default, and reading the body of a resulting chunked response
            // from Technitium has been observed to fail here with a generic
            // "Premature close" instead of the JSON Technitium actually sent.
            // Not requesting compression at all avoids that path entirely.
            compress: false,
            signal:   controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await readJsonBody(server, url, res, opts);
    } finally {
        clearTimeout(timer);
    }
}

async function apiGet(server, path, opts) {
    const url = `${server.url.replace(/\/$/, '')}/${path}`;
    const data = await fetchJson(server, url, opts);
    if (data.status !== 'ok') throw new Error(data.errorMessage || `API status: ${data.status}`);
    return data.response;
}

async function getSessionInfo(server) {
    const url = `${server.url.replace(/\/$/, '')}/api/user/session/get`;
    const data = await fetchJson(server, url);
    if (data.status !== 'ok') throw new Error(data.errorMessage || 'API error');
    return {
        version:            data.info?.version,
        dnsServerDomain:    data.info?.dnsServerDomain,
        clusterInitialized: data.info?.clusterInitialized || false,
        clusterDomain:      data.info?.clusterDomain || null,
        clusterNodes:       data.info?.clusterNodes  || null,
    };
}

function normalizeLabels(mainChartData, type) {
    if (!mainChartData?.labels?.length) return;
    const count = mainChartData.labels.length;
    const CFG = {
        LastHour:  { start: 1, init: d => d.setUTCSeconds(0, 0),           sub: (d, i) => d.setUTCMinutes(d.getUTCMinutes() - i), fmt: 'HH:mm' },
        LastDay:   { start: 1, init: d => d.setUTCMinutes(0, 0, 0),      sub: (d, i) => d.setUTCHours(d.getUTCHours() - i),  fmt: 'HH:mm' },
        LastWeek:  { start: 0, init: d => d.setUTCHours(0, 0, 0, 0),     sub: (d, i) => d.setUTCDate(d.getUTCDate() - i),   fmt: 'dd/MM' },
        LastMonth: { start: 0, init: d => d.setUTCHours(0, 0, 0, 0),     sub: (d, i) => d.setUTCDate(d.getUTCDate() - i),   fmt: 'dd/MM' },
        LastYear:  { start: 1, init: d => { d.setUTCHours(12,0,0,0); d.setUTCDate(1); }, sub: (d, i) => d.setUTCMonth(d.getUTCMonth() - i), fmt: 'MM/yyyy' },
    };
    const cfg = CFG[type];
    if (!cfg) return;
    const now = new Date();
    cfg.init(now);
    const labels = [];
    for (let i = count - 1 + cfg.start; i >= cfg.start; i--) { const d = new Date(now); cfg.sub(d, i); labels.push(d.toISOString()); }
    mainChartData.labels = labels;
    mainChartData.labelFormat = cfg.fmt;
}

async function getDashboard(server, type, node, tzOffset) {
    const resolvedType = type || 'LastHour';
    let path = 'api/dashboard/stats/get?type=' + resolvedType + '&utc=true';
    if (node) path += '&node=' + encodeURIComponent(node);
    const data = await apiGet(server, path);
    normalizeLabels(data.mainChartData, resolvedType);
    if (data.mainChartData) data.mainChartData.tzOffset = tzOffset;
    return data;
}

async function getSettings(server) {
    return apiGet(server, 'api/settings/get');
}

async function getClusterState(server, opts) {
    return apiGet(server, 'api/admin/cluster/state', opts);
}

// Node/OpenSSL's TLS verification failures surface as one of these specific error codes on
// the thrown error (verified empirically against node-fetch: a self-signed cert throws
// FetchError with err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT'). Distinct from other failure
// codes like ECONNREFUSED/ETIMEDOUT/ENOTFOUND, which should NOT trigger a fallback - those
// mean the node is actually unreachable, and retrying without verification wouldn't help.
const CERT_VERIFICATION_ERROR_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'CERT_UNTRUSTED',
    'CERT_REJECTED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function isCertVerificationError(err) {
    return CERT_VERIFICATION_ERROR_CODES.has(err?.code);
}

// Exposed so callers (e.g. the poller) can turn a bare TLS error code into an
// actionable log line instead of just the raw OpenSSL message, which doesn't
// mention that trusting the CA (e.g. via NODE_EXTRA_CA_CERTS) or setting
// "ignoreSsl: true" are the two ways out of it.
function certVerificationHint(err) {
    if (!isCertVerificationError(err)) return '';
    return ` - TLS certificate verification failed (${err.code}). Trust its CA (e.g. via NODE_EXTRA_CA_CERTS) or set "ignoreSsl: true" for this server in config.yml if skipping verification is acceptable.`;
}

// Hosts confirmed (this process's lifetime) to fail certificate verification, so repeat
// calls skip straight to the insecure agent instead of re-attempting a doomed verified
// connection every poll cycle. Without this, a permanently-untrusted cert still causes a
// fresh connection (and fresh DNS lookup) every cycle even though getClusterNodeState as a
// whole "succeeds" via fallback - the verified attempt alone never gets to reuse a pooled
// connection, since a TLS-rejected socket is discarded rather than kept alive for reuse.
const _insecureRequiredHosts = new Set();

// For a cluster peer's own reported URL: Technitium requires that to be HTTPS unconditionally,
// regardless of how the admin API itself is configured, and its cert may or may not be one the
// user has arranged for Node to trust (e.g. via NODE_EXTRA_CA_CERTS covering their whole PKI).
// Try with full verification first, so a properly-trusted setup stays verified end to end;
// only fall back to skipping verification if that specifically fails on a certificate error
// (not any other kind of failure, which a fallback wouldn't fix anyway) - and remember that
// outcome per host so it doesn't repeat the failing attempt on every subsequent poll.
async function getClusterNodeState(server) {
    const host = new URL(server.url).host;

    if (_insecureRequiredHosts.has(host))
        return getClusterState(server, { forceInsecure: true });

    try {
        return await getClusterState(server);
    } catch (err) {
        if (!isCertVerificationError(err)) throw err;
        // This is the only place this fallback is decided, and it's remembered
        // per host from here on, so log it once now or it never surfaces at all.
        console.warn(`[tls] ${host}: TLS certificate verification failed (${err.code}), falling back to insecure for this cluster peer from now on. Trust its CA (e.g. via NODE_EXTRA_CA_CERTS) to verify it properly instead.`);
        _insecureRequiredHosts.add(host);
        return await getClusterState(server, { forceInsecure: true });
    }
}

async function listQueryLogApps(server) {
    try {
        const res = await apiGet(server, 'api/apps/list');
        const found = [];
        for (const app of res.apps || []) {
            for (const da of app.dnsApps || []) {
                if (da.isQueryLogger || da.isQueryLogs) found.push(app.name);
            }
        }
        return found;
    } catch (_) { return []; }
}

// Throws on failure (network/auth/etc) instead of swallowing it, so the caller
// can distinguish "server unreachable" from "no matching app installed" rather
// than reporting both as a generic "not found".
async function discoverQueryLogsApp(server, preferredName) {
    const res = await apiGet(server, 'api/apps/list');
    const preferred = normalizeAppName(preferredName);
    let fallback = null;
    for (const app of res.apps || []) {
        for (const da of app.dnsApps || []) {
            if (!da.isQueryLogger && !da.isQueryLogs) continue;
            const found = { name: app.name, classPath: da.classPath };
            if (!fallback) fallback = found;
            if (!preferred || normalizeAppName(app.name) === preferred || queryLogAppTypeMatches(app.name, preferred)) return found;
        }
    }
    return preferred ? null : fallback;
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
    const res = await apiGet(server, 'api/logs/query?name=' + name + '&classPath=' + classPath + '&responseType=Recursive&entriesPerPage=' + limit + '&descendingOrder=true');
    return (res?.entries || [])
        .filter(e => typeof e.responseRtt === 'number')
        .map(e => ({ t: e.timestamp, rtt: e.responseRtt }));
}

async function getCacheMaxEntries(server) {
    try {
        const res = await getSettings(server);
        return res?.cacheMaximumEntries ?? 0;
    } catch (_) { return 0; }
}

async function getTopStats(server, statsType, limit, type, node) {
    let path = 'api/dashboard/stats/getTop?type=' + (type || 'LastHour') + '&utc=true&statsType=' + statsType + '&limit=' + limit;
    if (node) path += '&node=' + encodeURIComponent(node);
    return apiGet(server, path);
}

async function listCache(server, domain) {
    return apiGet(server, 'api/cache/list?domain=' + encodeURIComponent(domain) + '&direction=down');
}

async function dnsClientResolve(server, domain, type, protocol = 'UDP') {
    const path = 'api/dnsClient/resolve?server=this-server&domain=' + encodeURIComponent(domain) + '&type=' + encodeURIComponent(type) + '&protocol=' + encodeURIComponent(protocol);
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

// Parses semicolon/newline-separated key=value or key:value strings,
// handling multi-line values where a line after a key with no value
// becomes that key's value.
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

// Block list URLs can carry credentials. Strip them before anything reaches the browser.
function redactSecrets(text) {
    return String(text)
        .replace(/([?&](?:[\w.-]*(?:token|secret|passw(?:or)?d|pwd|signature)[\w.-]*|(?:[\w.-]*[_.-])?(?:api)?key|auth(?:orization)?)=)[^&;\s]+/gi, '$1redacted')
        .replace(/(\/\/)[^\/@\s;]+@/g, '$1redacted@');
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
            responses.push(result.value);
            extras.push(...collectStringValues(result.value));
        } else {
            errors.push(result.reason?.message || String(result.reason));
        }
    }

    const extraStrings = [...new Set(extras
        .filter(Boolean)
        .map(value => redactSecrets(String(value).trim()))
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


function redactListUrl(url) {
    return redactSecrets(String(url || ''));
}

function listDisplayName(url, source) {
    const src = String(source || '').toLowerCase();
    const raw = String(url || '');
    const lower = raw.toLowerCase();
    if (!raw) {
        if (src === 'blocked-zone') return 'Manual block list';
        if (src === 'advanced-blocking-app') return 'Advanced Blocking';
        return 'Block list';
    }
    if (lower.includes('multi-onlydomains')) return 'Hagezi Multi';
    if (lower.includes('tif-onlydomains')) return 'Hagezi TIF';
    if (lower.includes('doh-onlydomains')) return 'Hagezi DoH';
    if (lower.includes('stevenblack')) {
        return lower.includes('/porn/') ? 'StevenBlack (ads + porn)' : 'StevenBlack';
    }
    if (lower.includes('qfeeds') || lower.includes('malware_domains')) return 'Qfeeds malware';
    try {
        const parsed = new URL(raw);
        const seg = parsed.pathname.split('/').filter(Boolean).pop();
        return seg || parsed.hostname || 'Block list';
    } catch (_) {
        const seg = raw.split('/').filter(Boolean).pop();
        return seg || 'Block list';
    }
}

function cleanTxt(text) {
    let value = String(text || '').trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
    }
    return value.replace(/\\"/g, '"').trim();
}

function collectTxtStrings(obj, output = []) {
    if (obj == null || typeof obj !== 'object') return output;
    if (Array.isArray(obj)) {
        for (const item of obj) collectTxtStrings(item, output);
        return output;
    }
    const typeRaw = obj.Type ?? obj.type ?? obj.recordType ?? obj.dnsResourceRecordType;
    const type = String(typeRaw || '').toUpperCase();
    if (type === 'TXT' || type === '16') {
        const rdata = obj.RDATA || obj.Rdata || obj.rdata || obj.Data || obj.data;
        const strings = rdata && (rdata.CharacterStrings || rdata.characterStrings);
        let text = '';
        if (Array.isArray(strings) && strings.length) text = strings.map(part => String(part)).join('');
        else if (rdata && typeof rdata.Text === 'string') text = rdata.Text;
        else if (rdata && typeof rdata.text === 'string') text = rdata.text;
        else if (typeof rdata === 'string') text = rdata;
        else if (typeof obj.text === 'string') text = obj.text;
        else if (typeof obj.value === 'string') text = obj.value;
        text = cleanTxt(text);
        if (text) output.push(text);
        return output;
    }
    for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') collectTxtStrings(value, output);
    }
    return output;
}

function parseBlockingReport(text) {
    const out = {};
    for (const part of String(text || '').split(';')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const key = part.slice(0, idx).trim().toLowerCase();
        const value = part.slice(idx + 1).trim();
        if (key) out[key] = value;
    }
    return out;
}

function isBlockingReport(parsed) {
    const source = String(parsed.source || '').toLowerCase();
    if (source === 'block-list-zone' || source === 'blocked-zone' || source === 'advanced-blocking-app') return true;
    return Boolean(parsed.blocklisturl || parsed.blocklist);
}

function listsFromReportTexts(texts, domain) {
    const seen = new Set();
    const lists = [];
    for (const text of texts) {
        const parsed = parseBlockingReport(text);
        if (!isBlockingReport(parsed)) continue;
        const source = parsed.source || '';
        const url = parsed.blocklisturl || parsed.blocklist || '';
        const safeUrl = url ? redactListUrl(url) : '';
        const key = source.toLowerCase() + '|' + safeUrl;
        if (seen.has(key)) continue;
        seen.add(key);
        lists.push({
            name: listDisplayName(url, source),
            source,
            url: safeUrl,
            matchedDomain: parsed.domain || domain,
        });
    }
    return lists;
}

function listsFromBlockedResolve(data, domain) {
    const texts = [];
    for (const entry of data?.parsedEntries || []) {
        if (entry?.raw) texts.push(entry.raw);
    }
    if (data?.extraText) texts.push(data.extraText);
    return listsFromReportTexts(texts, domain);
}

async function resolveTxtBlockingReport(server, domain) {
    const response = await dnsClientResolve(server, domain, 'TXT');
    const texts = [...new Set(collectTxtStrings(response).map(text => text.trim()).filter(Boolean))];
    return { lists: listsFromReportTexts(texts, domain) };
}

function isLoopbackClient(ip) {
    let value = String(ip || '').trim().toLowerCase();
    if (value.startsWith('[') && value.includes(']')) value = value.slice(1, value.indexOf(']'));
    const zone = value.indexOf('%');
    if (zone !== -1) value = value.slice(0, zone);
    if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
    if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
    return value === '127.0.0.1' || value === '::1' || value === '0:0:0:0:0:0:0:1';
}

function clientIp(entry) {
    return entry?.clientIpAddress || entry?.clientIP || entry?.clientAddress || entry?.client || '';
}

const BLOCK_REPORT_CACHE_MAX = 5000;
const blockReportCache = new Map();

function rememberBlockReport(key, entry) {
    if (blockReportCache.size > BLOCK_REPORT_CACHE_MAX) {
        const now = Date.now();
        for (const [cachedKey, cached] of blockReportCache) {
            if (cached.expires <= now) blockReportCache.delete(cachedKey);
        }
    }
    if (blockReportCache.size > BLOCK_REPORT_CACHE_MAX) {
        const oldest = blockReportCache.keys().next().value;
        if (oldest !== undefined) blockReportCache.delete(oldest);
    }
    blockReportCache.set(key, entry);
}

async function listsForDomain(server, domain, stats) {
    const key = (server.name || server.url || '') + '\n' + domain;
    const now = Date.now();
    const cached = blockReportCache.get(key);
    if (cached && cached.expires > now) {
        if (stats) stats.cacheHits++;
        return cached;
    }
    if (stats) stats.lookups++;
    try {
        const report = await resolveTxtBlockingReport(server, domain);
        const lists = Array.isArray(report.lists) ? report.lists : [];
        const entry = {
            ok: true,
            lists,
            expires: now + (lists.length ? 30 * 60 * 1000 : 10 * 60 * 1000),
        };
        rememberBlockReport(key, entry);
        return entry;
    } catch (_) {
        const entry = { ok: false, lists: [], expires: now + 60 * 1000 };
        rememberBlockReport(key, entry);
        return entry;
    }
}

async function mapPool(items, limit, fn) {
    const workers = Math.min(limit, items.length);
    if (!workers) return;
    let cursor = 0;
    async function run() {
        while (cursor < items.length) {
            const index = cursor++;
            await fn(items[index]);
        }
    }
    await Promise.all(Array.from({ length: workers }, () => run()));
}

const COUNT_LIST_LIMITS = {
    pageSize: 1000,
    maxPages: 20,
    maxNames: 1000,
    windowMs: 60 * 60 * 1000,
};

const blockedLogRuns = new Map();

async function collectBlockedLog(serverList) {
    const servers = (serverList || []).filter(server => server && server.queryLogsApp);
    if (!servers.length) {
        return {
            ok: false,
            error: 'Query logs are not available on the selected server.',
            blockedQueries: 0,
            domains: 0,
            skippedLoopback: 0,
            limited: { names: 0, hits: 0 },
            lookupLimit: COUNT_LIST_LIMITS.maxNames,
            pagesFetched: 0,
            totalPages: 0,
            totalEntries: 0,
            entriesScanned: 0,
            lookups: 0,
            cacheHits: 0,
            lists: [],
            unmatched: { hits: 0, domains: 0 },
            unresolved: { hits: 0, domains: 0 },
            truncated: false,
        };
    }

    const totals = new Map();
    const stats = { lookups: 0, cacheHits: 0 };
    let blockedQueries = 0;
    const allNames = new Set();
    let skippedLoopback = 0;
    let unmatchedHits = 0;
    const unmatchedNames = new Set();
    let unresolvedHits = 0;
    const unresolvedNames = new Set();
    let truncated = false;
    let limitedNames = 0;
    let limitedHits = 0;
    let pagesFetched = 0;
    let totalPages = 0;
    let totalEntries = 0;
    let entriesScanned = 0;

    for (const server of servers) {
        const page = await listBlockedQueries(server);
        if (page.truncated) truncated = true;
        pagesFetched += page.pagesFetched;
        totalPages += page.totalPages;
        totalEntries += page.totalEntries;
        entriesScanned += page.entries.length;
        const counts = new Map();
        for (const entry of page.entries) {
            if (isLoopbackClient(clientIp(entry))) {
                skippedLoopback++;
                continue;
            }
            blockedQueries++;
            const name = String(entry.qname || '').trim().replace(/\.+$/, '').toLowerCase();
            if (!name) {
                unresolvedHits++;
                continue;
            }
            counts.set(name, (counts.get(name) || 0) + 1);
        }
        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const selected = ranked.slice(0, COUNT_LIST_LIMITS.maxNames);
        const skippedByLimit = ranked.slice(selected.length);
        limitedNames += skippedByLimit.length;
        limitedHits += skippedByLimit.reduce((sum, [, hits]) => sum + hits, 0);
        for (const [name] of ranked) allNames.add(name);
        await mapPool(selected.map(([name]) => name), 4, async (name) => {
            const hitCount = counts.get(name);
            const found = await listsForDomain(server, name, stats);
            if (!found.ok) {
                unresolvedHits += hitCount;
                unresolvedNames.add(name);
                return;
            }
            if (!found.lists.length) {
                unmatchedHits += hitCount;
                unmatchedNames.add(name);
                return;
            }
            for (const list of found.lists) {
                const key = (list.source || '') + '|' + (list.url || '') + '|' + (list.name || '');
                const row = totals.get(key) || {
                    name: list.name || 'Block list',
                    url: list.url || '',
                    source: list.source || '',
                    hits: 0,
                    names: new Set(),
                };
                row.hits += hitCount;
                row.names.add(name);
                totals.set(key, row);
            }
        });
    }

    return {
        ok: true,
        updatedAt: new Date().toISOString(),
        blockedQueries,
        domains: allNames.size,
        skippedLoopback,
        limited: { names: limitedNames, hits: limitedHits },
        lookupLimit: COUNT_LIST_LIMITS.maxNames,
        pagesFetched,
        totalPages,
        totalEntries,
        entriesScanned,
        lookups: stats.lookups,
        cacheHits: stats.cacheHits,
        lists: [...totals.values()].map(({ names, ...row }) => ({ ...row, domains: names.size })).sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name)),
        unmatched: { hits: unmatchedHits, domains: unmatchedNames.size },
        unresolved: { hits: unresolvedHits, domains: unresolvedNames.size },
        truncated,
        error: null,
    };
}

function summarizeBlockedLog(serverList) {
    const key = (serverList || [])
        .map(server => server.name || server.url || '')
        .sort()
        .join('\n');
    const existing = blockedLogRuns.get(key);
    if (existing) return existing;
    const run = collectBlockedLog(serverList).finally(() => {
        if (blockedLogRuns.get(key) === run) blockedLogRuns.delete(key);
    });
    blockedLogRuns.set(key, run);
    return run;
}


async function listBlockedQueries(server) {
    if (!server.queryLogsApp) {
        return { entries: [], pagesFetched: 0, totalPages: 0, totalEntries: 0, truncated: false };
    }
    const name = encodeURIComponent(server.queryLogsApp.name);
    const classPath = encodeURIComponent(server.queryLogsApp.classPath);
    const end = new Date();
    const start = new Date(end.getTime() - COUNT_LIST_LIMITS.windowMs);
    const startStr = start.toISOString();
    const endStr = end.toISOString();
    const entries = [];
    let truncated = false;
    let pagesFetched = 0;
    let totalPages = 0;
    let totalEntries = null;
    for (let page = 1; page <= COUNT_LIST_LIMITS.maxPages; page++) {
        let path = 'api/logs/query?name=' + name + '&classPath=' + classPath
            + '&responseType=Blocked&entriesPerPage=' + COUNT_LIST_LIMITS.pageSize
            + '&pageNumber=' + page + '&descendingOrder=true';
        path += '&start=' + encodeURIComponent(startStr);
        path += '&end=' + encodeURIComponent(endStr);
        const res = await apiGet(server, path);
        const batch = Array.isArray(res?.entries) ? res.entries : [];
        entries.push(...batch);
        pagesFetched++;
        totalPages = Number(res?.totalPages) || page;
        if (totalEntries === null) totalEntries = Number(res?.totalEntries) || 0;
        if (batch.length === 0 || page >= totalPages) break;
        if (page === COUNT_LIST_LIMITS.maxPages) truncated = true;
    }
    return { entries, pagesFetched, totalPages, totalEntries: totalEntries || 0, truncated };
}

module.exports = { getSessionInfo, getDashboard, getSettings, getClusterState, getClusterNodeState, listQueryLogApps, discoverQueryLogsApp, getQueryLogs, getRttSample, getCacheMaxEntries, getTopStats, listCache, resolveBlockedDomain, resolveTxtBlockingReport, listsFromBlockedResolve, listsForDomain, listBlockedQueries, summarizeBlockedLog, isLoopbackClient, listsFromReportTexts, redactListUrl, redactSecrets, certVerificationHint };
