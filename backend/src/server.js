'use strict';

const express   = require('express');
const helmet    = require('helmet');
const http      = require('http');
const https     = require('https');
const path      = require('path');
const fs        = require('fs');
const yaml      = require('js-yaml');
const fetch     = require('node-fetch');
const Poller    = require('./poller');
const Updater   = require('./updater');
const { listQueryLogApps, discoverQueryLogsApp, getCacheMaxEntries, getDashboard, getTopStats, listCache, getMetrics, resolveBlockedDomain } = require('./technitium');

const PACKAGE = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
const VERSION = PACKAGE.version;
const STARTED_AT = new Date().toISOString();
const CLUSTER_KEY = '__cluster';

const CONFIG_PATHS = [
    '/etc/tdns-stats/config.yml',
    path.join(__dirname, '../../config.yml')
];

function semverGreater(v1, v2) {
    const parse = (v) => {
        const parts = v.split('.').map(p => parseInt(p, 10) || 0);
        return { major: parts[0], minor: parts[1], patch: parts[2] };
    };
    const a = parse(v1);
    const b = parse(v2);
    if (a.major !== b.major) return a.major > b.major;
    if (a.minor !== b.minor) return a.minor > b.minor;
    return a.patch > b.patch;
}

function loadConfig() {
    for (const p of CONFIG_PATHS) {
        if (fs.existsSync(p)) {
            return yaml.load(fs.readFileSync(p, 'utf8'));
        }
    }
    throw new Error('No config.yml found. Copy config.example.yml to config.yml and fill it in.');
}

const config  = loadConfig();
const servers = (config.servers || []).map(s => ({
    name:              s.name,
    url:               s.url.replace(/\/$/, ''),
    token:             s.token,
    ignoreSsl:         !!s.ignoreSsl,
    queryLogsAppName:  s.queryLogsApp || null,
    queryLogsApp:      null,
    color:             s.color || null,
}));

if (servers.length === 0) throw new Error('No servers defined in config.yml');

const PORT = config.port || 3000;

const clients = new Set();

function normalizeDomain(value) {
    return String(value || '')
        .trim()
        .replace(/^\.+|\.+$/g, '')
        .toLowerCase();
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
    for (const res of clients) {
        try { res.write(data); } catch (_) { clients.delete(res); }
    }
}

function broadcastViewerCount() {
    broadcast({ type: 'viewer-count', data: { count: clients.size } });
}

async function start() {
    // Discover query logs app for each server in parallel
    await Promise.allSettled(servers.map(async s => {
        const [app, cacheMax] = await Promise.allSettled([
            discoverQueryLogsApp(s, s.queryLogsAppName),
            getCacheMaxEntries(s)
        ]);
        s.queryLogsApp    = app.status    === 'fulfilled' ? app.value    : null;
        s.cacheMaxEntries = cacheMax.status === 'fulfilled' ? cacheMax.value : 0;

        if (s.queryLogsApp) {
            const src = s.queryLogsAppName ? 'configured' : 'auto-discovered';
            console.log(`${s.name}: query logs via "${s.queryLogsApp.name}" (${src}), cacheMax=${s.cacheMaxEntries || 'unlimited'}`);
        } else if (s.queryLogsAppName) {
            const available = await listQueryLogApps(s).catch(() => []);
            const hint = available.length
                ? `Available apps: ${available.map(n => `"${n}"`).join(', ')}`
                : 'No query log apps found on this server';
            console.warn(`${s.name}: queryLogsApp "${s.queryLogsAppName}" not found. ${hint}`);
        } else {
            console.log(`${s.name}: no query logs app, cacheMax=${s.cacheMaxEntries || 'unlimited'}`);
        }
    }));

    const poller = new Poller(servers, broadcast, config);
    poller.start();

    const updater = new Updater(path.join(__dirname, '../..'));
    await updater.detectCapability();

    const app = express();

    function getValidatedRangeType(type) {
        return VALID_TYPES.has(type) ? type : 'LastHour';
    }

    function resolveServer(serverName) {
        return serverName === CLUSTER_KEY ? servers[0] : servers.find(s => s.name === serverName);
    }

    app.use(helmet({
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                defaultSrc:    ["'self'"],
                scriptSrc:     ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
                styleSrc:      ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "fonts.googleapis.com"],
                fontSrc:       ["'self'", "fonts.gstatic.com", "cdn.jsdelivr.net"],
                imgSrc:        ["'self'", "data:"],
                connectSrc:    ["'self'", "cdn.jsdelivr.net"],
                objectSrc:     ["'none'"],
                frameAncestors:["'self'"]
            }
        }
    }));

    app.use(express.static(path.join(__dirname, '../../frontend')));

    app.get('/api/stream', (req, res) => {
        req.setTimeout(0);
        res.setHeader('Content-Type',  'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection',    'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // Tell browser to wait 5s before retrying if connection is lost
        res.write('retry: 5000\n\n');

        let ping = null;
        const cleanup = () => {
            const removed = clients.delete(res);
            if (clients.size === 0) poller.pause();
            if (removed) broadcastViewerCount();
            if (ping) clearInterval(ping);
        };

        res.on('error', (err) => {
            console.warn('[stream] Response error:', err.message);
            cleanup();
        });

        clients.add(res);
        if (clients.size === 1) poller.resume();
        broadcastViewerCount();

        try {
            const state = poller.getState();
            if (state.nodes) res.write(`data: ${JSON.stringify({ type: 'stats', data: state.nodes })}\n\n`);
            if (state.perf && Object.keys(state.perf).length > 0) {
                for (const [server, data] of Object.entries(state.perf)) {
                    res.write(`data: ${JSON.stringify({ type: 'perf', server, data })}\n\n`);
                }
            }
        } catch (err) {
            console.error('[stream] Initial write failed:', err.message);
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

    app.get('/api/servers', (req, res) => {
        res.json(servers.map(s => ({ name: s.name, url: s.url })));
    });

    app.get('/api/config', (req, res) => {
        const fallback = config.serverColors || ['blue', 'green', 'ora', 'pur', 'teal', 'yel'];
        const serverColors = {};
        servers.forEach((s, i) => {
            serverColors[s.name] = s.color || (Array.isArray(fallback) ? fallback[i % fallback.length] : 'blue');
        });
        res.json({
            maxEntries: config.feed?.maxEntries || 200,
            serverColors,
        });
    });

    const VALID_TYPES = new Set(['LastHour', 'LastDay', 'LastWeek', 'LastMonth', 'LastYear']);
    const VALID_STATS = new Set(['TopDomains', 'TopBlockedDomains', 'TopClients']);

    app.get('/api/metrics', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const results = await Promise.allSettled(servers.map(s => getMetrics(s)));
            const uptimestamps = {};
            servers.forEach((s, i) => {
                if (results[i].status === 'fulfilled')
                    uptimestamps[s.name] = results[i].value.uptimestamp || null;
            });
            res.json({ uptimestamps });
        } catch (e) { res.status(502).json({ error: e.message }); }
    });

    app.get('/api/dashboard', async (req, res) => {
        const { server: serverName, type, tz } = req.query;
        const rangeType = getValidatedRangeType(type);
        const server = resolveServer(serverName);
        if (!server) return res.status(404).json({ error: 'Unknown server' });
        try {
            const data = await getDashboard(server, rangeType, serverName === CLUSTER_KEY ? 'cluster' : null, parseInt(tz) || 0);
            res.json(data);
        } catch (e) { res.status(502).json({ error: e.message }); }
    });

    app.get('/api/top', async (req, res) => {
        const { server: serverName, type, statsType, tz } = req.query;
        if (!VALID_STATS.has(statsType)) return res.status(400).json({ error: 'Invalid statsType' });
        const rangeType = getValidatedRangeType(type);
        const server = resolveServer(serverName);
        if (!server) return res.status(404).json({ error: 'Unknown server' });
        try {
            const data = await getTopStats(server, statsType, config.top?.limit || 20, rangeType, serverName === CLUSTER_KEY ? 'cluster' : null, parseInt(tz) || 0);
            res.json(data);
        } catch (e) { res.status(502).json({ error: e.message }); }
    });

    app.get('/api/cache/search', async (req, res) => {
        const domain = normalizeDomain(req.query.domain);
        const serverName = String(req.query.server || 'all');
        const blockedLookup = String(req.query.blocked || '').toLowerCase() === '1' || String(req.query.blocked || '').toLowerCase() === 'true';
        if (!domain) return res.status(400).json({ error: 'Domain is required' });
        if (domain.length > 253 || !/^[a-z0-9_*.-]+$/.test(domain)) return res.status(400).json({ error: 'Invalid domain' });

        const state = poller.getState();
        const cluster = state.nodes?.__cluster;
        const targets = getCacheSearchTargets(serverName, state);
        if (!targets || !targets.length) return res.status(404).json({ error: 'Unknown server' });

        const results = await Promise.all(targets.map(async server => {
            try {
                const data = await listCache(server, domain);
                const node = state.nodes?.[server.name] || {};
                return {
                    server: server.displayName || server.name,
                    domain: server.domain || node.dnsServerDomain || server.name,
                    url: server.url,
                    ok: true,
                    ...summarizeCache(data),
                };
            } catch (e) {
                return {
                    server: server.displayName || server.name,
                    domain: server.domain || state.nodes?.[server.name]?.dnsServerDomain || server.name,
                    url: server.url,
                    ok: false,
                    cached: false,
                    zoneCount: 0,
                    recordCount: 0,
                    zones: [],
                    records: [],
                    error: e.message,
                };
            }
        }));

        let blockedSummary = null;
        if (blockedLookup) {
            const blockedTarget = getBlockedLookupTarget(serverName, state);
            if (blockedTarget) {
                try {
                    const data = await resolveBlockedDomain(blockedTarget, domain);
                    const isBlocked = Boolean(
                        (Array.isArray(data.records) && data.records.length > 0) ||
                        data.source ||
                        data.group ||
                        (data.parsed && Object.keys(data.parsed).length > 0) ||
                        data.extraText
                    );
                    blockedSummary = {
                        server: blockedTarget.displayName || blockedTarget.name,
                        domain: blockedTarget.domain || blockedTarget.name,
                        ok: true,
                        blocked: isBlocked,
                        blockedMeta: {
                            source: data.source || data.extraText || undefined,
                            group: data.group || undefined,
                            parsed: data.parsed || {},
                            entries: Array.isArray(data.parsedEntries) ? data.parsedEntries : [],
                            raw: data.extraText || undefined,
                        },
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

    app.get('/api/version', (req, res) => {
        res.json({ version: VERSION, updaterEnabled: updater.capable });
    });

    app.get('/api/changelog', (req, res) => {
        const changelogPath = path.join(__dirname, '../../CHANGELOG.md');
        try {
            const changelog = fs.readFileSync(changelogPath, 'utf8');
            res.json({ changelog });
        } catch (e) {
            console.error('[changelog] Failed to read:', e.message);
            res.status(500).json({ error: 'Failed to read changelog' });
        }
    });

    app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', version: VERSION, started_at: STARTED_AT });
    });

    app.get('/api/updates/check', async (req, res) => {
        try {
            const response = await fetch('https://api.github.com/repos/Hemsby/tdns-stats/releases/latest', {
                timeout: 5000,
                headers: { 'User-Agent': 'tdns-stats' }
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
                }
            });
        } catch (e) {
            console.error('[updates] Error checking for updates:', e.message);
            res.status(502).json({ error: 'Failed to check updates' });
        }
    });

    app.post('/api/updates/trigger', async (req, res) => {
        try {
            broadcast({
                type: 'update-status',
                data: { status: 'updating' }
            });

            res.json({ status: 'update_started' });

            setTimeout(async () => {
                try {
                    await updater.executeUpdate();
                } catch (e) {
                    console.error('[updates] Update failed:', e.message);
                    broadcast({
                        type: 'update-status',
                        data: { status: null, error: e.message }
                    });
                }
            }, 100);
        } catch (e) {
            console.error('[updates] Failed to trigger update:', e.message);
            res.status(500).json({ error: 'Failed to trigger update' });
        }
    });

    const tlsCfg = config.https;
    if (tlsCfg?.pem || (tlsCfg?.cert && tlsCfg?.key)) {
        let tlsOpts;
        try {
            if (tlsCfg.pem) {
                const pem = fs.readFileSync(tlsCfg.pem);
                tlsOpts = { cert: pem, key: pem };
            } else {
                tlsOpts = {
                    cert: fs.readFileSync(tlsCfg.cert),
                    key:  fs.readFileSync(tlsCfg.key),
                };
            }
        } catch (e) {
            throw new Error(`Failed to load TLS certificate: ${e.message}`);
        }
        https.createServer(tlsOpts, app).listen(PORT, '0.0.0.0', () => {
            console.log(`tdns-stats listening on https port ${PORT}`);
            console.log(`Monitoring ${servers.length} server(s): ${servers.map(s => s.name).join(', ')}`);
        });
    } else {
        http.createServer(app).listen(PORT, '0.0.0.0', () => {
            console.log(`tdns-stats listening on http port ${PORT}`);
            console.log(`Monitoring ${servers.length} server(s): ${servers.map(s => s.name).join(', ')}`);
        });
    }
}

start().catch(err => { console.error('Startup error:', err); process.exit(1); });
