'use strict';

const express = require('express');
const helmet = require('helmet');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const yaml = require('js-yaml');
const nodeFetch = require('node-fetch');
const Poller = require('./poller');
const Updater = require('./updater');
const log = require('./log');
const { listQueryLogApps, discoverQueryLogsApp, getCacheMaxEntries, getSettings, listCache } = require('./technitium');
const {
    resolveBlockedDomain,
    listsFromBlockedResolve,
    listsForDomain,
    summarizeBlockedLog,
    redactListUrl,
    isBlockedName,
} = require('./blocklists');

// ---- Version and config ----------------------------------------------------------
// The package file sits at the root of the project. The second path is the
// layout the project used to have, so an install that has not been updated
// yet still finds its version instead of refusing to start.
function readPackage() {
    const paths = [path.join(__dirname, '../../package.json'), path.join(__dirname, '../package.json')];
    for (const p of paths) {
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (_) {
            // Try the next one.
        }
    }
    return { version: '0.0.0' };
}

const PACKAGE = readPackage();
const VERSION = PACKAGE.version;
const STARTED_AT = new Date().toISOString();
const CLUSTER_KEY = '__cluster';

const CONFIG_PATHS = ['/etc/tdns-stats/config.yml', path.join(__dirname, '../../config.yml')];

// `--config <path>` names the config file to read. Without it, the search
// order in CONFIG_PATHS decides. Both `--config path` and `--config=path` work.
function configPathFromArgv(argv) {
    const index = argv.indexOf('--config');
    if (index !== -1) {
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw new Error('--config needs a path to a config file.');
        return value;
    }
    const inline = argv.find(arg => arg.startsWith('--config='));
    if (inline !== undefined) {
        const value = inline.slice('--config='.length);
        if (!value) throw new Error('--config needs a path to a config file.');
        return value;
    }
    return null;
}

function semverGreater(v1, v2) {
    const parts = v => v.split('.').map(p => parseInt(p, 10) || 0);
    const [a, b] = [parts(v1), parts(v2)];
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

function loadConfig(argv = process.argv) {
    const given = configPathFromArgv(argv);
    if (given) {
        if (!fs.existsSync(given)) throw new Error(`Config file not found: ${given}`);
        return yaml.load(fs.readFileSync(given, 'utf8'));
    }
    for (const p of CONFIG_PATHS) {
        if (fs.existsSync(p)) {
            return yaml.load(fs.readFileSync(p, 'utf8'));
        }
    }
    throw new Error('No config.yml found. Copy config.example.yml to config.yml and fill it in.');
}

// The config file is read on first use rather than on import, so requiring this
// module (from a test, or from tooling) does not need a config.yml on disk.
let config = null;
let servers = null;

function setConfig(cfg) {
    const list = (cfg.servers || []).map(s => ({
        name: s.name,
        url: s.url.replace(/\/$/, ''),
        token: s.token,
        ignoreSsl: !!s.ignoreSsl,
        queryLogsAppName: s.queryLogsApp || null,
        queryLogsApp: null,
        queryLogsLookupFailed: false,
        color: s.color || null,
    }));
    if (list.length === 0) throw new Error('No servers defined in config.yml');
    config = cfg;
    servers = list;
    log.configure(cfg.debug);
    return config;
}

function getConfig() {
    if (!config) setConfig(loadConfig());
    return config;
}

const clients = new Set();
const sessions = new Set();
const SESSION_COOKIE = 'tdns-stats_session';
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

// ---- Login sessions --------------------------------------------------------------
function parseCookies(req) {
    const raw = req.headers.cookie;
    if (!raw) return {};
    const cookies = {};
    for (const part of raw.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return cookies;
}

function signSession(token) {
    const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
    return `${token}.${hmac}`;
}

function verifySession(value) {
    if (!value) return null;
    const idx = value.lastIndexOf('.');
    if (idx === -1) return null;
    const token = value.slice(0, idx);
    const hmac = value.slice(idx + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
    try {
        if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null;
    } catch (_) {
        return null;
    }
    return token;
}

// ---- Cache and block list lookups ------------------------------------------------
function normalizeDomain(value) {
    return String(value || '')
        .trim()
        .replace(/^\.+|\.+$/g, '')
        .toLowerCase();
}

function redactBlockedMeta(value) {
    if (typeof value === 'string') return redactListUrl(value);
    if (Array.isArray(value)) return value.map(redactBlockedMeta);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) out[key] = redactBlockedMeta(item);
        return out;
    }
    return value;
}

function summarizeCache(data) {
    const zones = Array.isArray(data?.zones) ? data.zones : [];
    const directRecords = Array.isArray(data?.records) ? data.records : [];
    const recordCount = zones.reduce((sum, z) => sum + (Array.isArray(z.records) ? z.records.length : 0), directRecords.length);

    return {
        cached: zones.length > 0 || directRecords.length > 0,
        zoneCount: zones.length,
        recordCount,
        zones,
        records: directRecords,
    };
}

function uniqueServers(list) {
    const seen = new Set();
    return list.filter(server => {
        const key = server.url || server.name;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function getCacheSearchTargets(serverName, state) {
    const cluster = state.nodes?.__cluster;
    const configuredTargets = servers.map(server => ({
        ...server,
        displayName: server.name,
        domain: state.nodes?.[server.name]?.dnsServerDomain || server.name,
    }));

    if (serverName !== CLUSTER_KEY && serverName !== 'all') {
        const server = configuredTargets.find(s => s.name === serverName);
        return server ? [server] : null;
    }

    if (!cluster) return configuredTargets;

    const baseServer = servers.find(server => state.nodes?.[server.name]?.clusterInitialized) || servers[0];
    const clusterTargets = (cluster.clusterNodes || [])
        .filter(node => node.url)
        .map(node => ({
            ...baseServer,
            name: node.name || node.id || node.url,
            displayName: node.name || node.url,
            domain: node.name || node.url,
            url: String(node.url).replace(/\/$/, ''),
        }));

    return uniqueServers([...clusterTargets, ...configuredTargets]);
}

function getBlockedLookupTarget(serverName, state) {
    const cluster = state.nodes?.__cluster;
    if (cluster && (serverName === 'all' || serverName === CLUSTER_KEY)) {
        const primaryServer = servers.find(server => state.nodes?.[server.name]?.clusterInitialized) || servers[0];
        const clusterDomain = cluster.clusterDomain || state.nodes?.[primaryServer.name]?.dnsServerDomain || 'Cluster';
        return {
            ...primaryServer,
            displayName: clusterDomain,
            domain: clusterDomain,
        };
    }

    const targets = getCacheSearchTargets(serverName, state);
    return targets?.[0] || null;
}

function broadcast(msg) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of Array.from(clients)) {
        try {
            res.write(data);
        } catch (_) {
            clients.delete(res);
        }
    }
}

function broadcastViewerCount() {
    broadcast({ type: 'viewer-count', data: { count: clients.size } });
}

// ---- Apps on the servers ---------------------------------------------------------
// How often to retry app discovery for servers that don't have a queryLogsApp
// yet. Technitium (or its query log app) can still be starting up when
// tdns-stats does, and that one-shot lookup at boot never got a second try.
// A server that wasn't ready in time stayed without live feed/RTT for the
// life of the process until someone noticed and restarted tdns-stats.
const APP_DISCOVERY_RETRY_MS = 60000;
let appDiscoveryTimer = null;

async function discoverServerApps(s) {
    const [app, cacheMax] = await Promise.allSettled([discoverQueryLogsApp(s, s.queryLogsAppName), getCacheMaxEntries(s)]);
    s.cacheMaxEntries = cacheMax.status === 'fulfilled' ? cacheMax.value : 0;

    if (app.status === 'fulfilled' && app.value) {
        s.queryLogsApp = app.value;
        s.queryLogsLookupFailed = false;
        const src = s.queryLogsAppName ? 'configured' : 'auto-discovered';
        log.debug(`[discovery] ${s.name}: query logs via "${s.queryLogsApp.name}" (${src}), cacheMax=${s.cacheMaxEntries || 'unlimited'}`);
        return;
    }

    s.queryLogsApp = null;
    // A thrown lookup (DNS or network down at boot) is not the same as the app
    // being absent. Track it so the dashboard can say "retrying" instead of "not found".
    s.queryLogsLookupFailed = app.status === 'rejected';

    if (!s.queryLogsAppName) {
        log.debug(`[discovery] ${s.name}: no query logs app, cacheMax=${s.cacheMaxEntries || 'unlimited'}`);
        return;
    }

    if (app.status === 'rejected') {
        console.warn(
            `[discovery] ${s.name}: queryLogsApp "${s.queryLogsAppName}" lookup failed: ${app.reason?.message || app.reason}. Will retry.`,
        );
        return;
    }

    // The apps/list call itself succeeded but no app matched. Safe to ask
    // again for the list of what IS installed, since that endpoint just worked.
    const available = await listQueryLogApps(s).catch(() => []);
    const hint = available.length ? `Available apps: ${available.map(n => `"${n}"`).join(', ')}` : 'No query log apps found on this server';
    console.warn(`[discovery] ${s.name}: queryLogsApp "${s.queryLogsAppName}" not found. ${hint}`);
}

function scheduleAppDiscoveryRetry() {
    if (appDiscoveryTimer) return;
    appDiscoveryTimer = setInterval(async () => {
        const pending = servers.filter(s => s.queryLogsAppName && !s.queryLogsApp);
        if (pending.length === 0) {
            clearInterval(appDiscoveryTimer);
            appDiscoveryTimer = null;
            return;
        }
        await Promise.allSettled(pending.map(s => discoverServerApps(s)));
    }, APP_DISCOVERY_RETRY_MS);
}

// ---- API routes ------------------------------------------------------------------

// The fetch implementation is swappable so a test can answer the update check
// without a network. Production always uses node-fetch; `__setFetch` is the only
// way to change it.
let fetchImpl = nodeFetch;
function __setFetch(fn) {
    fetchImpl = fn || nodeFetch;
}
function createApp(poller, updater) {
    const cfg = getConfig();
    const app = express();

    app.use(
        helmet({
            contentSecurityPolicy: {
                useDefaults: false,
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'", 'cdn.jsdelivr.net'],
                    styleSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'fonts.googleapis.com'],
                    fontSrc: ["'self'", 'fonts.gstatic.com', 'cdn.jsdelivr.net'],
                    imgSrc: ["'self'", 'data:'],
                    connectSrc: ["'self'", 'cdn.jsdelivr.net'],
                    objectSrc: ["'none'"],
                    frameAncestors: ["'self'"],
                },
            },
        }),
    );

    app.use(express.static(path.join(__dirname, '../../frontend')));

    function requireToken(req, res, next) {
        const signed = parseCookies(req)[SESSION_COOKIE];
        const token = verifySession(signed);
        if (!token || !sessions.has(token)) {
            console.warn(`[auth] token rejected: endpoint=${req.path} token=${token || 'none'}`);
            return res.status(401).json({ error: 'Unauthorized' });
        }
        log.debug(`[auth] token accepted: endpoint=${req.path} token=${token}`);
        next();
    }

    app.get('/api/session', (req, res) => {
        const token = crypto.randomBytes(16).toString('hex');
        sessions.add(token);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${signSession(token)}; HttpOnly; SameSite=Lax; Path=/`);
        log.debug('[auth] session token created:', token);
        res.json({ ok: true });
    });

    app.get('/api/stream', async (req, res) => {
        const signed = parseCookies(req)[SESSION_COOKIE];
        const sessionToken = verifySession(signed);
        if (!sessionToken || !sessions.has(sessionToken)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        req.setTimeout(0);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // Tell browser to wait 5s before retrying if connection is lost
        res.write('retry: 5000\n\n');

        res.sessionToken = sessionToken;

        let ping = null;
        const cleanup = () => {
            const removed = clients.delete(res);
            if (removed) {
                if (clients.size === 0) poller.pause();
                broadcastViewerCount();
            }
            if (res.sessionToken) {
                sessions.delete(res.sessionToken);
                log.debug('[auth] session token removed:', res.sessionToken);
                res.sessionToken = null;
            }
            clearInterval(ping);
            ping = null;
        };

        res.on('error', err => {
            console.warn('[stream] response error:', err.message);
            cleanup();
        });

        clients.add(res);
        broadcastViewerCount();

        const cachedTop = poller.getState().top;
        if (cachedTop && Object.keys(cachedTop).length > 0) {
            for (const [server, data] of Object.entries(cachedTop)) {
                res.write(`data: ${JSON.stringify({ type: 'top', server, data })}\n\n`);
            }
        }
        if (clients.size === 1) await poller.resume();
        if (!clients.has(res)) return;

        try {
            const state = poller.getState();
            if (state.nodes) res.write(`data: ${JSON.stringify({ type: 'stats', data: state.nodes })}\n\n`);
            if (state.perf && Object.keys(state.perf).length > 0) {
                for (const [server, data] of Object.entries(state.perf)) {
                    res.write(`data: ${JSON.stringify({ type: 'perf', server, data })}\n\n`);
                }
            }
            if (state.rttSeries && Object.keys(state.rttSeries).length > 0) {
                for (const [server, data] of Object.entries(state.rttSeries)) {
                    res.write(`data: ${JSON.stringify({ type: 'perf-series', server, data })}\n\n`);
                }
            }
            // Fetch all range data fresh on every SSE connect so the client
            // never sees stale chart or top list data after reconnect.
            poller.refreshRangeData();
        } catch (err) {
            console.error('[stream] initial write failed:', err.message);
            cleanup();
        }

        ping = setInterval(() => {
            try {
                res.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`);
            } catch (_) {
                cleanup();
            }
        }, 20000);

        req.on('close', cleanup);
    });

    app.get('/api/config', (req, res) => {
        const fallback = cfg.serverColors || ['blue', 'green', 'ora', 'pur', 'teal', 'yel'];
        const serverColors = {};
        const cacheMaxEntries = {};
        servers.forEach((s, i) => {
            serverColors[s.name] = s.color || fallback[i % fallback.length];
            cacheMaxEntries[s.name] = s.cacheMaxEntries || 0;
        });
        res.json({
            maxEntries: cfg.feed?.maxEntries || 200,
            serverColors,
            cacheMaxEntries,
        });
    });

    app.get('/api/watch-server', requireToken, (req, res) => {
        const name = req.query.server;
        if (name && (name === CLUSTER_KEY || servers.some(s => s.name === name))) {
            poller.setWatchedServer(name);
        }
        res.json({ ok: true });
    });

    app.get('/api/cache/search', requireToken, async (req, res) => {
        const rawDomain = String(req.query.domain || '').trim();
        const domain = normalizeDomain(req.query.domain);
        const serverName = String(req.query.server || 'all');
        const blockedLookup =
            String(req.query.blocked || '').toLowerCase() === '1' || String(req.query.blocked || '').toLowerCase() === 'true';
        const skipCacheListing = blockedLookup && String(req.query.cache || '') === '0';
        if (!rawDomain) return res.status(400).json({ error: 'Domain is required' });
        if (rawDomain.startsWith('.') || rawDomain.endsWith('.'))
            return res.status(400).json({ error: 'Domain cannot start or end with a dot' });
        if (rawDomain.includes('..')) return res.status(400).json({ error: 'Domain cannot contain consecutive dots' });
        if (rawDomain.length > 253) return res.status(400).json({ error: 'Domain too long (max 253 characters)' });
        if (!/^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)+$/.test(domain))
            return res.status(400).json({ error: 'Invalid domain format' });
        if (domain.split('.').some(label => label.length > 63))
            return res.status(400).json({ error: 'Domain label too long (max 63 characters)' });

        const state = poller.getState();
        const cluster = state.nodes?.__cluster;
        const targets = getCacheSearchTargets(serverName, state);
        if (!targets || !targets.length) return res.status(404).json({ error: 'Unknown server' });

        // The Top Stats popover only needs the blocked summary, so it skips the per-node cache listing.
        const results = skipCacheListing
            ? []
            : await Promise.all(
                  targets.map(async server => {
                      const target = {
                          server: server.displayName || server.name,
                          domain: server.domain || state.nodes?.[server.name]?.dnsServerDomain || server.name,
                          url: server.url,
                      };
                      try {
                          const data = await listCache(server, domain);
                          return { ...target, ok: true, ...summarizeCache(data) };
                      } catch (e) {
                          return {
                              ...target,
                              ok: false,
                              cached: false,
                              zoneCount: 0,
                              recordCount: 0,
                              zones: [],
                              records: [],
                              error: e.message,
                          };
                      }
                  }),
              );

        let blockedSummary = null;
        if (blockedLookup) {
            const blockedTarget = getBlockedLookupTarget(serverName, state);
            if (blockedTarget) {
                try {
                    // One settings read per user-triggered check, so the result can say whether
                    // Technitium is allowed to report built-in block lists. Null if it can't be read.
                    const [data, settings] = await Promise.all([
                        resolveBlockedDomain(blockedTarget, domain),
                        getSettings(blockedTarget).catch(() => null),
                    ]);
                    const txtBlockingReport =
                        typeof settings?.allowTxtBlockingReport === 'boolean' ? settings.allowTxtBlockingReport : null;
                    let lists = listsFromBlockedResolve(data, domain);
                    let reportError = null;
                    // A and AAAA already carry the report on some servers. Ask once,
                    // and only when that response did not name a list.
                    if (!lists.length) {
                        const found = await listsForDomain(blockedTarget, domain);
                        if (!found.ok) reportError = 'The TXT blocking report could not be read.';
                        else lists = Array.isArray(found.lists) ? found.lists : [];
                    }
                    const isBlocked = isBlockedName(data, lists);
                    const target = {
                        server: blockedTarget.displayName || blockedTarget.name,
                        domain: blockedTarget.domain || blockedTarget.name,
                    };
                    blockedSummary = {
                        ...target,
                        ok: true,
                        blocked: isBlocked,
                        txtBlockingReport,
                        lists,
                        reportError,
                        blockedMeta: redactBlockedMeta({
                            source: data.source || data.extraText || undefined,
                            group: data.group || undefined,
                            parsed: data.parsed || {},
                            entries: Array.isArray(data.parsedEntries) ? data.parsedEntries : [],
                            raw: data.extraText || undefined,
                        }),
                    };
                } catch (e) {
                    blockedSummary = {
                        server: blockedTarget.displayName || blockedTarget.name,
                        domain: blockedTarget.domain || blockedTarget.name,
                        ok: false,
                        error: e.message,
                    };
                }
            }
        }

        res.json({
            domain,
            cluster: !!cluster,
            blockedLookup,
            blockedSummary,
            searchedAllNodes: targets.length > 1,
            cachedNodeCount: results.filter(r => r.cached).length,
            recordCount: results.reduce((sum, r) => sum + (r.recordCount || 0), 0),
            results,
        });
    });

    app.post('/api/block-list-stats', requireToken, async (req, res) => {
        const serverName = String(req.query.server || 'all');
        let targets = servers;
        if (serverName !== 'all' && serverName !== CLUSTER_KEY) {
            const server = servers.find(s => s.name === serverName);
            if (!server) return res.status(404).json({ ok: false, error: 'Unknown server' });
            targets = [server];
        }

        try {
            const data = await summarizeBlockedLog(targets);
            if (data.ok) {
                console.log(
                    `[block-list-stats] ${data.blockedQueries} blocked, ${data.lookups} lookups, ${data.skippedLoopback} loopback skipped`,
                );
            }
            res.json(data);
        } catch (_) {
            res.status(502).json({ ok: false, error: 'The blocked query log could not be read.' });
        }
    });

    app.get('/api/version', (req, res) => {
        res.json({ version: VERSION, updaterEnabled: updater.capable });
    });

    app.get('/api/changelog', (req, res) => {
        const changelogPath = path.join(__dirname, '../../CHANGELOG.md');
        try {
            const changelog = fs.readFileSync(changelogPath, 'utf8');
            res.json({ changelog });
        } catch (e) {
            console.error('[changelog] failed to read:', e.message);
            res.status(500).json({ error: 'Failed to read changelog' });
        }
    });

    app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', version: VERSION, started_at: STARTED_AT });
    });

    app.get('/api/updates/check', requireToken, async (req, res) => {
        try {
            const response = await fetchImpl('https://api.github.com/repos/Hemsby/tdns-stats/releases/latest', {
                timeout: 5000,
                headers: { 'User-Agent': 'tdns-stats' },
            });

            let latestVersion = null;
            let release = null;

            if (response.ok) {
                release = await response.json();
                latestVersion = release.tag_name ? release.tag_name.replace(/^v/, '') : null;
            } else if (response.status === 404) {
                return res.json({ updateAvailable: false, currentVersion: VERSION });
            } else {
                return res.status(502).json({ error: 'Failed to fetch release info' });
            }

            if (!latestVersion) {
                return res.json({ updateAvailable: false, currentVersion: VERSION });
            }

            const updateAvailable = semverGreater(latestVersion, VERSION);

            res.json({
                currentVersion: VERSION,
                latestVersion,
                updateAvailable,
                downloadUrl: release.html_url,
                releaseNotes: release.body,
            });

            broadcast({
                type: 'update-status',
                data: {
                    status: 'checked',
                    currentVersion: VERSION,
                    latestVersion,
                    updateAvailable,
                },
            });
        } catch (e) {
            console.error('[update] error checking for updates:', e.message);
            res.status(502).json({ error: 'Failed to check updates' });
        }
    });

    app.post('/api/updates/trigger', requireToken, async (req, res) => {
        if (!updater.capable) return res.status(403).json({ error: 'Updater not available' });
        try {
            broadcast({
                type: 'update-status',
                data: { status: 'updating' },
            });

            res.json({ status: 'update_started' });

            setTimeout(async () => {
                try {
                    await updater.executeUpdate();
                } catch (e) {
                    console.error('[update] update failed:', e.message);
                    broadcast({
                        type: 'update-status',
                        data: { status: null, error: e.message },
                    });
                }
            }, 100);
        } catch (e) {
            console.error('[update] failed to trigger update:', e.message);
            res.status(500).json({ error: 'Failed to trigger update' });
        }
    });

    return app;
}

// ---- Starting the server ---------------------------------------------------------
async function start() {
    const cfg = getConfig();

    // Discover query logs app for each server in parallel
    await Promise.allSettled(servers.map(s => discoverServerApps(s)));

    if (servers.some(s => s.queryLogsAppName && !s.queryLogsApp)) {
        scheduleAppDiscoveryRetry();
    }

    const poller = new Poller(servers, broadcast, cfg);
    poller.start();

    const updater = new Updater(path.join(__dirname, '../..'));
    await updater.detectCapability();

    const app = createApp(poller, updater);

    const PORT = cfg.port || 3000;
    const tlsCfg = cfg.https;
    if (tlsCfg?.pem || (tlsCfg?.cert && tlsCfg?.key)) {
        let tlsOpts;
        try {
            if (tlsCfg.pem) {
                const pem = fs.readFileSync(tlsCfg.pem);
                tlsOpts = { cert: pem, key: pem };
            } else {
                tlsOpts = {
                    cert: fs.readFileSync(tlsCfg.cert),
                    key: fs.readFileSync(tlsCfg.key),
                };
            }
        } catch (e) {
            throw new Error(`Failed to load TLS certificate: ${e.message}`);
        }
        https.createServer(tlsOpts, app).listen(PORT, '0.0.0.0', () => {
            console.log(`[startup] tdns-stats listening on https port ${PORT}`);
            console.log(`[startup] monitoring ${servers.length} server(s): ${servers.map(s => s.name).join(', ')}`);
        });
    } else {
        http.createServer(app).listen(PORT, '0.0.0.0', () => {
            console.log(`[startup] tdns-stats listening on http port ${PORT}`);
            console.log(`[startup] monitoring ${servers.length} server(s): ${servers.map(s => s.name).join(', ')}`);
        });
    }

    // Memory telemetry: log hourly so leaks can be distinguished from normal heap growth.
    setInterval(
        () => {
            const mem = process.memoryUsage();
            const handles = process._getActiveHandles ? process._getActiveHandles() : [];
            const handleCounts = handles.reduce((acc, h) => {
                const name = h?.constructor?.name || 'Unknown';
                acc[name] = (acc[name] || 0) + 1;
                return acc;
            }, {});
            log.debug(
                '[memory] rss=%s heapUsed=%s external=%s arrayBuffers=%s handles=%j',
                formatBytes(mem.rss),
                formatBytes(mem.heapUsed),
                formatBytes(mem.external),
                formatBytes(mem.arrayBuffers || 0),
                handleCounts,
            );
        },
        60 * 60 * 1000,
    ).unref();
}

function formatBytes(b) {
    if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
    return b + ' B';
}

if (require.main === module) {
    start().catch(err => {
        console.error('[startup] startup error:', err);
        process.exit(1);
    });
}

// Module-level mutable state, grouped so a test can reset it in one call instead
// of reaching into individual variables.
function __resetState() {
    clients.clear();
    sessions.clear();
    if (appDiscoveryTimer) {
        clearInterval(appDiscoveryTimer);
        appDiscoveryTimer = null;
    }
}

module.exports = {
    start,
    createApp,
    getConfig,
    setConfig,
    loadConfig,
    configPathFromArgv,
    __setFetch,
    __resetState,
    // The session helpers, exported so they can be tested without a server.
    parseCookies,
    signSession,
    verifySession,
};
