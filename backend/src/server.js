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
const { listQueryLogApps, discoverQueryLogsApp, getCacheMaxEntries, getDashboard, getTopStats } = require('./technitium');

const PACKAGE = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
const VERSION = PACKAGE.version;
const STARTED_AT = new Date().toISOString();

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

function broadcast(msg) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) {
        try { res.write(data); } catch (_) { clients.delete(res); }
    }
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

    const app = express();

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
        res.setHeader('Content-Type',  'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection',    'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        clients.add(res);
        if (clients.size === 1) poller.resume();

        const state = poller.getState();
        if (state.nodes) res.write(`data: ${JSON.stringify({ type: 'stats', data: state.nodes })}\n\n`);
        if (state.perf && Object.keys(state.perf).length > 0) {
            for (const [server, data] of Object.entries(state.perf)) {
                res.write(`data: ${JSON.stringify({ type: 'perf', server, data })}

`);
            }
        }

        const ping = setInterval(() => {
            try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); }
        }, 20000);

        req.on('close', () => { clients.delete(res); if (clients.size === 0) poller.pause(); clearInterval(ping); });
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

    app.get('/api/dashboard', async (req, res) => {
        const { server: serverName, type } = req.query;
        const rangeType = VALID_TYPES.has(type) ? type : 'LastHour';
        const isCluster = serverName === '__cluster';
        const server = isCluster ? servers[0] : servers.find(s => s.name === serverName);
        if (!server) return res.status(404).json({ error: 'Unknown server' });
        try {
            const data = await getDashboard(server, rangeType, isCluster ? 'cluster' : null);
            res.json(data);
        } catch (e) { res.status(502).json({ error: e.message }); }
    });

    app.get('/api/top', async (req, res) => {
        const { server: serverName, type, statsType } = req.query;
        const rangeType = VALID_TYPES.has(type) ? type : 'LastHour';
        const VALID_STATS = new Set(['TopDomains', 'TopBlockedDomains', 'TopClients']);
        if (!VALID_STATS.has(statsType)) return res.status(400).json({ error: 'Invalid statsType' });
        const isCluster = serverName === '__cluster';
        const server = isCluster ? servers[0] : servers.find(s => s.name === serverName);
        if (!server) return res.status(404).json({ error: 'Unknown server' });
        try {
            const data = await getTopStats(server, statsType, config.top?.limit || 20, rangeType, isCluster ? 'cluster' : null);
            res.json(data);
        } catch (e) { res.status(502).json({ error: e.message }); }
    });

    app.get('/api/version', (req, res) => {
        res.json({ version: VERSION });
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
