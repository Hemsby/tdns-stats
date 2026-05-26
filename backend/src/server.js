'use strict';

const express   = require('express');
const helmet    = require('helmet');
const http      = require('http');
const https     = require('https');
const path      = require('path');
const fs        = require('fs');
const yaml      = require('js-yaml');
const Poller    = require('./poller');
const { listQueryLogApps, discoverQueryLogsApp, getCacheMaxEntries, getDashboard, getTopStats } = require('./technitium');

const CONFIG_PATHS = [
    '/etc/tdns-stats/config.yml',
    path.join(__dirname, '../../config.yml')
];

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
                connectSrc:    ["'self'"],
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

        const state = poller.getState();
        if (state.nodes) res.write(`data: ${JSON.stringify({ type: 'stats', data: state.nodes })}\n\n`);

        const ping = setInterval(() => {
            try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); }
        }, 20000);

        req.on('close', () => { clients.delete(res); clearInterval(ping); });
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
