'use strict';

// Everything to do with block lists: the reports a server sends, the names of
// the lists those reports name, and the count of the blocked queries each list
// caught. The transport and the generic Technitium reads stay in technitium.js.

const { apiGet, dnsClientResolve, normalizeName } = require('./technitium');

// The caches this module keeps between requests: the blocking report of a
// name, and a count run that two callers share.
const state = {
    blockReportCache: new Map(),
    blockedLogRuns: new Map(),
};

// Test seam. Not used by production code.
function __resetState() {
    state.blockReportCache.clear();
    state.blockedLogRuns.clear();
}

// ---- Reading the DNS answer ------------------------------------------------------
// The fields a DNS answer can have, and the keys it can come under.
const RECORD_FIELDS = ['type', 'recordType', 'dnsResourceRecordType', 'address', 'value', 'data', 'text', 'rdata'];
const RECORD_LIST_KEYS = ['records', 'responseRecords', 'answers', 'answer', 'Answer', 'Authority', 'Additional'];
const RECORD_SINGLE_KEYS = ['record', 'rdata'];

function isRecordLike(item) {
    return !!item && typeof item === 'object' && RECORD_FIELDS.some(field => field in item);
}

function extractDnsClientRecords(response) {
    if (!response) return [];
    const out = [];

    for (const key of RECORD_LIST_KEYS) {
        if (Array.isArray(response[key])) out.push(...response[key]);
    }
    if (Array.isArray(response.rawResponses)) {
        for (const raw of response.rawResponses) out.push(...extractDnsClientRecords(raw));
    }
    for (const key of RECORD_SINGLE_KEYS) {
        if (response[key]) out.push(response[key]);
    }

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
    return normalizeName(key);
}

// Parses semicolon/newline-separated key=value or key:value strings,
// handling multi-line values where a line after a key with no value
// becomes that key's value.
function parseDnsClientExtraText(value) {
    if (!value) return {};
    const raw = String(value);
    const lines = raw
        .split(/[;\n]+/)
        .map(v => v.trim())
        .filter(Boolean);
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
        .replace(
            /([?&](?:[\w.-]*(?:token|secret|passw(?:or)?d|pwd|signature)[\w.-]*|(?:[\w.-]*[_.-])?(?:api)?key|auth(?:orization)?)=)[^&;\s]+/gi,
            '$1redacted',
        )
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

    const extraStrings = [
        ...new Set(
            extras
                .filter(Boolean)
                .map(value => redactSecrets(String(value).trim()))
                .filter(Boolean),
        ),
    ];
    const extraText = extraStrings.join('; ');
    const parsedEntries = extraStrings.map(text => ({ ...parseDnsClientExtraText(text), raw: text }));
    const parsed = parsedEntries[0] || {};

    return {
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

// ---- Known list names ------------------------------------------------------------
const STEVENBLACK_VARIANTS = [
    'fakenews',
    'gambling',
    'porn',
    'social',
    'fakenews-gambling',
    'fakenews-porn',
    'fakenews-social',
    'gambling-porn',
    'gambling-social',
    'porn-social',
    'fakenews-gambling-porn',
    'fakenews-gambling-social',
    'fakenews-porn-social',
    'gambling-porn-social',
    'fakenews-gambling-porn-social',
];

const HAGEZI_TIERS = [
    ['light', 'HaGeZi Multi LIGHT'],
    ['multi', 'HaGeZi Multi NORMAL'],
    ['pro.plus.mini', 'HaGeZi Multi PRO++ Mini'],
    ['pro.plus', 'HaGeZi Multi PRO++'],
    ['pro.mini', 'HaGeZi Multi PRO Mini'],
    ['pro', 'HaGeZi Multi PRO'],
    ['ultimate.mini', 'HaGeZi Multi ULTIMATE Mini'],
    ['ultimate', 'HaGeZi Multi ULTIMATE'],
    ['tif.medium', 'HaGeZi TIF Medium'],
    ['tif.mini', 'HaGeZi TIF Mini'],
    ['tif', 'HaGeZi TIF'],
    ['doh', 'HaGeZi DOH'],
];

const HAGEZI_NRD_ENDS = [
    ['nrd7.txt', 7],
    ['nrd14-8.txt', 14],
    ['nrd21-15.txt', 21],
    ['nrd28-22.txt', 28],
    ['nrd35-29.txt', 35],
];

function hageziNrdEnd(url) {
    const match = String(url || '')
        .toLowerCase()
        .match(/(?:^|\/)nrd(\d+)(?:-\d+)?\.txt(?:[?#]|$)/);
    return match ? Number(match[1]) : 0;
}

const SHRESHTA_NRD = [
    ['nrd-1w', '1 week'],
    ['nrd-1m', '1 month'],
];

const PHISHING_ARMY_FILES = ['phishing-army-domains.txt', 'phishing_army_blocklist.txt', 'phishing_army_blocklist_extended.txt'];

const NAMED_LISTS = [
    { source: 'blocked-zone', name: 'Manual block list' },
    { source: 'advanced-blocking-app', name: 'Advanced Blocking' },

    ...HAGEZI_TIERS.map(([tier, name]) => ({ url: `${tier}-onlydomains`, name })),
    { url: 'spam-tlds-adblock-aggressive', name: 'HaGeZi Most Abused TLDs Aggressive' },
    { url: 'spam-tlds-adblock', name: 'HaGeZi Most Abused TLDs' },

    ...HAGEZI_NRD_ENDS.map(([file, days]) => ({
        url: file,
        name: `HaGeZi NRD (${days} days)`,
    })),
    ...SHRESHTA_NRD.map(([file, range]) => ({
        url: file,
        name: `Shreshta NRD (${range})`,
    })),

    ...STEVENBLACK_VARIANTS.map(variant => ({
        url: `/alternates/${variant}/hosts`,
        name: `StevenBlack (ads + ${variant.split('-').join(' + ')})`,
    })),
    { url: 'stevenblack', name: 'StevenBlack' },

    ...PHISHING_ARMY_FILES.map(file => ({ url: file, name: 'Phishing Army' })),

    { url: ['oisd', 'big'], name: 'OISD Big' },
    { url: ['oisd', 'nsfw'], name: 'OISD NSFW' },

    { url: ['qfeeds', 'malware_domains'], name: 'Qfeeds malware' },
    { url: ['dandelionsprout', 'antimalwaredomains.txt'], name: 'DandelionSprout Anti-Malware' },
];

function listDisplayName(url, source) {
    const src = String(source || '').toLowerCase();
    const raw = String(url || '');
    const lower = raw.toLowerCase();
    if (!raw) {
        const bySource = NAMED_LISTS.find(rule => rule.source === src);
        return bySource ? bySource.name : 'Block list';
    }
    for (const rule of NAMED_LISTS) {
        if (!rule.url) continue;
        const needles = Array.isArray(rule.url) ? rule.url : [rule.url];
        if (needles.every(needle => lower.includes(needle))) return rule.name;
    }
    try {
        const parsed = new URL(raw);
        const seg = parsed.pathname.split('/').filter(Boolean).pop();
        return seg || parsed.hostname || 'Block list';
    } catch (_) {
        const seg = raw.split('/').filter(Boolean).pop();
        return seg || 'Block list';
    }
}

// ---- Blocking report -------------------------------------------------------------
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

function listsFromReportStrings(reportStrings, domain) {
    const seen = new Set();
    const lists = [];
    for (const reportString of reportStrings) {
        const parsed = parseBlockingReport(reportString);
        if (!isBlockingReport(parsed)) continue;
        const source = parsed.source || '';
        const url = parsed.blocklisturl || parsed.blocklist || '';
        const safeUrl = url ? redactListUrl(url) : '';
        const key = source.toLowerCase() + '|' + safeUrl;
        if (seen.has(key)) continue;
        seen.add(key);
        const nrdEnd = hageziNrdEnd(safeUrl);
        lists.push({
            name: listDisplayName(url, source),
            source,
            url: safeUrl,
            group: nrdEnd ? 'hagezi-nrd' : '',
            nrdEnd,
            matchedDomain: parsed.domain || domain,
        });
    }
    return lists;
}

function listsFromBlockedResolve(data, domain) {
    const reportStrings = [];
    for (const entry of data?.parsedEntries || []) {
        if (entry?.raw) reportStrings.push(entry.raw);
    }
    if (data?.extraText) reportStrings.push(data.extraText);
    return listsFromReportStrings(reportStrings, domain);
}

async function resolveTxtBlockingReport(server, domain) {
    const response = await dnsClientResolve(server, domain, 'TXT');
    const reportStrings = [
        ...new Set(
            collectTxtStrings(response)
                .map(reportString => reportString.trim())
                .filter(Boolean),
        ),
    ];
    return { lists: listsFromReportStrings(reportStrings, domain) };
}

/**
 * Whether the server blocked the name.
 *
 * A name is blocked when the server named the list that blocked it, or sent a
 * blocking report of any kind. The records of the answer are not a signal: a
 * name that resolved normally has records too.
 */
function isBlockedName(data, lists) {
    return Boolean(
        (lists && lists.length) || data?.source || data?.group || (data?.parsed && Object.keys(data.parsed).length > 0) || data?.extraText,
    );
}

function isLoopbackClient(ip) {
    let value = String(ip || '')
        .trim()
        .toLowerCase();
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

function rememberBlockReport(key, entry) {
    if (state.blockReportCache.size > BLOCK_REPORT_CACHE_MAX) {
        const now = Date.now();
        for (const [cachedKey, cached] of state.blockReportCache) {
            if (cached.expires <= now) state.blockReportCache.delete(cachedKey);
        }
    }
    if (state.blockReportCache.size > BLOCK_REPORT_CACHE_MAX) {
        const oldest = state.blockReportCache.keys().next().value;
        if (oldest !== undefined) state.blockReportCache.delete(oldest);
    }
    state.blockReportCache.set(key, entry);
}

async function listsForDomain(server, domain, stats) {
    const key = (server.name || server.url || '') + '\n' + domain;
    const now = Date.now();
    const cached = state.blockReportCache.get(key);
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

// ---- Counting the blocked queries ------------------------------------------------
const COUNT_LIST_LIMITS = {
    pageSize: 1000,
    maxPages: 20,
    maxNames: 1000,
    windowMs: 60 * 60 * 1000,
};

/**
 * The fields every blocked-log answer carries.
 *
 * A run that found nothing and a run that found something answer with the
 * same fields; the ones a run fills in are written over these.
 */
const BLOCKED_LOG_FIELDS = {
    ok: false,
    error: null,
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

async function collectBlockedLog(serverList) {
    const servers = (serverList || []).filter(server => server && server.queryLogsApp);
    if (!servers.length) {
        return { ...BLOCKED_LOG_FIELDS, error: 'Query logs are not available on the selected server.' };
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
            const name = String(entry.qname || '')
                .trim()
                .replace(/\.+$/, '')
                .toLowerCase();
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
        await mapPool(
            selected.map(([name]) => name),
            4,
            async name => {
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
                    const key = list.group ? 'group|' + list.group : (list.source || '') + '|' + (list.url || '') + '|' + (list.name || '');
                    const row = totals.get(key) || {
                        name: list.name || 'Block list',
                        url: list.url || '',
                        urls: new Set(),
                        source: list.source || '',
                        group: list.group || '',
                        nrdEnd: 0,
                        hits: 0,
                        names: new Set(),
                    };
                    row.hits += hitCount;
                    row.names.add(name);
                    if (list.url) row.urls.add(list.url);
                    if ((list.nrdEnd || 0) > row.nrdEnd) {
                        row.nrdEnd = list.nrdEnd;
                        row.name = list.name || row.name;
                    }
                    totals.set(key, row);
                }
            },
        );
    }

    return {
        ...BLOCKED_LOG_FIELDS,
        ok: true,
        updatedAt: new Date().toISOString(),
        blockedQueries,
        domains: allNames.size,
        skippedLoopback,
        limited: { names: limitedNames, hits: limitedHits },
        pagesFetched,
        totalPages,
        totalEntries,
        entriesScanned,
        lookups: stats.lookups,
        cacheHits: stats.cacheHits,
        lists: [...totals.values()]
            .map(({ names, urls, nrdEnd, group, ...row }) => ({
                ...row,
                url: urls.size ? [...urls].sort((a, b) => hageziNrdEnd(a) - hageziNrdEnd(b)).join(', ') : row.url,
                domains: names.size,
            }))
            .sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name)),
        unmatched: { hits: unmatchedHits, domains: unmatchedNames.size },
        unresolved: { hits: unresolvedHits, domains: unresolvedNames.size },
        truncated,
    };
}

function summarizeBlockedLog(serverList) {
    const key = (serverList || [])
        .map(server => server.name || server.url || '')
        .sort()
        .join('\n');
    const existing = state.blockedLogRuns.get(key);
    if (existing) return existing;
    const run = collectBlockedLog(serverList).finally(() => {
        if (state.blockedLogRuns.get(key) === run) state.blockedLogRuns.delete(key);
    });
    state.blockedLogRuns.set(key, run);
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
        let path =
            'api/logs/query?name=' +
            name +
            '&classPath=' +
            classPath +
            '&responseType=Blocked&entriesPerPage=' +
            COUNT_LIST_LIMITS.pageSize +
            '&pageNumber=' +
            page +
            '&descendingOrder=true';
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

module.exports = {
    resolveBlockedDomain,
    resolveTxtBlockingReport,
    isBlockedName,
    listsFromBlockedResolve,
    listsFromReportStrings,
    listsForDomain,
    collectBlockedLog,
    summarizeBlockedLog,
    listBlockedQueries,
    redactListUrl,
    redactSecrets,
    listDisplayName,
    parseBlockingReport,
    isBlockingReport,
    parseDnsClientExtraText,
    collectTxtStrings,
    collectStringValues,
    extractDnsClientRecords,
    cleanTxt,
    hageziNrdEnd,
    isLoopbackClient,
    clientIp,
    COUNT_LIST_LIMITS,
    NAMED_LISTS,
    __resetState,
};
