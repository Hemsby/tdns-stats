'use strict';

const { getDashboard, getTopStats, getQueryLogs, getRttSample, getSessionInfo, getClusterState, getMetrics } = require('./technitium');

const CLUSTER_KEY = '__cluster';
const UNSAFE_MAINTENANCE_OFFSETS = [0, 10, 20, 30, 40, 50];

function getUnsafeSeconds(uptimestamps) {
    const unsafe = new Set();
    if (!uptimestamps) return unsafe;
    for (const ts of Object.values(uptimestamps)) {
        if (!ts) continue;
        const base = Math.floor(new Date(ts).getTime() / 1000) % 60;
        for (const o of UNSAFE_MAINTENANCE_OFFSETS) unsafe.add((base + o) % 60);
    }
    return unsafe;
}

function msUntilSafe(servers, uptimestamps) {
    const unsafe = getUnsafeSeconds(uptimestamps);
    if (unsafe.size === 0) return 0;

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000) % 60;
    const msOffset = nowMs % 1000;

    let targetSec = -1;
    for (let s = 0; s < 60; s++) {
        if (!unsafe.has(s)) {
            targetSec = s;
            break;
        }
    }
    if (targetSec === -1) {
        console.log('[safety] msUntilSafe: all seconds unsafe, waiting 60s');
        return 60000;
    }

    // Calculate delay to arrive at the start of the target safe second
    let delay = ((60 + targetSec - nowSec) % 60) * 1000 - msOffset;

    if (delay > 0 && delay <= 1500) delay += 60000;
    if (delay <= 0) delay = 0;

    return delay;
}

class Poller {
    constructor(servers, broadcast, cfg) {
        this.servers   = servers;
        this.broadcast = broadcast;
        this.cfg = {
            statsInterval: (cfg?.poll?.statsInterval || 10) * 1000,
            feedInterval:  (cfg?.poll?.feedInterval  || 3)  * 1000,
            topInterval:   (cfg?.poll?.topInterval   || 30) * 1000,
            perfInterval:  (cfg?.poll?.perfInterval  || 30) * 1000,
            rangeInterval: 60000,
            topLimit:      cfg?.top?.limit      || 20,
            rttSample:     cfg?.rtt?.sampleSize || 500,
            feedPageSize:  cfg?.feed?.pageSize  || 20,
        };
        this.state     = {};
        this.state.perf  = {};
        this.state.rangeData = {};
        this._jitterState  = {};
        this.feedCursors   = {};
        this.clusterServer = null;
        this._watchedServer = null;
        this._statsTimer = null;
        this._feedTimer  = null;
        this._topTimer   = null;
        this._perfTimer  = null;
        this._rangeTimer = null;
        this._running    = false;
    }

    _clearTimers() {
        clearInterval(this._statsTimer);
        clearInterval(this._feedTimer);
        clearInterval(this._topTimer);
        clearInterval(this._perfTimer);
        clearInterval(this._rangeTimer);
        this._statsTimer = null;
        this._feedTimer  = null;
        this._topTimer   = null;
        this._perfTimer  = null;
        this._rangeTimer = null;
        this._running    = false;
    }

    _startTimers() {
        if (this._running) return;
        this._statsTimer = setInterval(() => this._pollStats(),       this.cfg.statsInterval);
        this._feedTimer  = setInterval(() => this._pollFeed(),        this.cfg.feedInterval);
        this._topTimer   = setInterval(() => this._pollTop(),         this.cfg.topInterval);
        this._perfTimer  = setInterval(() => this._pollPerformance(), this.cfg.perfInterval);
        this._running    = true;
    }

    _pollAll() {
        this._pollStats();
        this._pollFeed();
        this._pollTop();
        this._pollPerformance();
        this._pollRangeData();
    }

    start() {
        this._pollAll();
        this._startTimers();
    }

    stop() {
        this._clearTimers();
    }

    pause() {
        this._clearTimers();
    }

    resume() {
        this._pollAll();
        this._startTimers();
    }

    setWatchedServer(name) {
        this._watchedServer = name;
    }

    getState() {
        return this.state;
    }

    async _pollRangeData() {
        const primary = this._watchedServer
            ? this.servers.find(s => s.name === this._watchedServer)
            : this.servers[0];
        if (!primary) {
            this._rangeTimer = setTimeout(() => this._pollRangeData(), this.cfg.rangeInterval);
            return;
        }

        const metricsTargets = [primary];
        if (this.clusterServer && this.clusterServer.name !== primary.name) metricsTargets.push(this.clusterServer);
        const metricsResults = await Promise.allSettled(metricsTargets.map(s => getMetrics(s)));
        const uptimestamps = {};
        metricsTargets.forEach((s, i) => {
            if (metricsResults[i].status === 'fulfilled')
                uptimestamps[s.name] = metricsResults[i].value.uptimestamp || null;
        });

        const delay = msUntilSafe(metricsTargets, uptimestamps);
        if (delay > 0) {
            console.log(`[safety] _pollRangeData: delayed ${delay}ms`);
            this._rangeTimer = setTimeout(() => this._pollRangeData(), delay);
            return;
        }

        const rangeType = 'LastDay';
        const tzOffset = 0;

        try {
            const data = await getDashboard(primary, rangeType, null, tzOffset);
            const key = primary.name + ':' + rangeType;
            this.state.rangeData[key] = data;
            this.broadcast({ type: 'range-dashboard', range: rangeType, server: primary.name, data });
        } catch (_) { /* ignore */ }

        try {
            const [topDomains, topBlocked, topClients] = await Promise.allSettled([
                getTopStats(primary, 'TopDomains',        this.cfg.topLimit, rangeType),
                getTopStats(primary, 'TopBlockedDomains', this.cfg.topLimit, rangeType),
                getTopStats(primary, 'TopClients',        this.cfg.topLimit, rangeType)
            ]);
            const topData = {
                domains: topDomains.status === 'fulfilled' ? (topDomains.value?.topDomains        || []) : [],
                blocked: topBlocked.status === 'fulfilled' ? (topBlocked.value?.topBlockedDomains || []) : [],
                clients: topClients.status === 'fulfilled' ? (topClients.value?.topClients        || []) : []
            };
            const key = primary.name + ':' + rangeType + ':top';
            this.state.rangeData[key] = topData;
            this.broadcast({ type: 'range-top', range: rangeType, server: primary.name, data: topData });
        } catch (_) { /* ignore */ }

        if (this.clusterServer) {
            try {
                const data = await getDashboard(this.clusterServer, rangeType, 'cluster', tzOffset);
                const key = CLUSTER_KEY + ':' + rangeType;
                this.state.rangeData[key] = data;
                this.broadcast({ type: 'range-dashboard', range: rangeType, server: CLUSTER_KEY, data });
            } catch (_) { /* ignore */ }

            try {
                const [topDomains, topBlocked, topClients] = await Promise.allSettled([
                    getTopStats(this.clusterServer, 'TopDomains',        this.cfg.topLimit, rangeType, 'cluster'),
                    getTopStats(this.clusterServer, 'TopBlockedDomains', this.cfg.topLimit, rangeType, 'cluster'),
                    getTopStats(this.clusterServer, 'TopClients',        this.cfg.topLimit, rangeType, 'cluster')
                ]);
                const topData = {
                    domains: topDomains.status === 'fulfilled' ? (topDomains.value?.topDomains        || []) : [],
                    blocked: topBlocked.status === 'fulfilled' ? (topBlocked.value?.topBlockedDomains || []) : [],
                    clients: topClients.status === 'fulfilled' ? (topClients.value?.topClients        || []) : []
                };
                const key = CLUSTER_KEY + ':' + rangeType + ':top';
                this.state.rangeData[key] = topData;
                this.broadcast({ type: 'range-top', range: rangeType, server: CLUSTER_KEY, data: topData });
            } catch (_) { /* ignore */ }
        }
        this._rangeTimer = setTimeout(() => this._pollRangeData(), this.cfg.rangeInterval);
    }

    async _pollStats() {
        const results = await Promise.allSettled(
            this.servers.map(s => this._fetchStats(s))
        );

        const nodes = {};
        results.forEach((r, i) => {
            const key = this.servers[i].name;
            nodes[key] = r.status === 'fulfilled' ? r.value : { error: r.reason?.message };
        });

        // Detect cluster server (first healthy node with clusterInitialized)
        if (!this.clusterServer) {
            const idx = results.findIndex(r => r.status === 'fulfilled' && r.value.clusterInitialized);
            if (idx !== -1) this.clusterServer = this.servers[idx];
        }

        // Fetch cluster aggregate stats
        if (this.clusterServer) {
            try {
                const [clusterDash, clusterState] = await Promise.all([
                    getDashboard(this.clusterServer, 'LastHour', 'cluster'),
                    getClusterState(this.clusterServer)
                ]);

                // Query each node individually to get its configLastSynced
                const enrichedNodes = await Promise.all(
                    (clusterState?.clusterNodes || []).map(async node => {
                        try {
                            const nodeState = await getClusterState({ ...this.clusterServer, url: node.url });
                            // Find this node's entry in the response to get its configLastSynced
                            const selfNode = (nodeState?.clusterNodes || []).find(n => n.id === node.id || n.name === node.name);
                            return {
                                ...node,
                                configLastSynced: selfNode?.configLastSynced || null
                            };
                        } catch (_) {
                            return { ...node, configLastSynced: null };
                        }
                    })
                );

                nodes[CLUSTER_KEY] = {
                    clusterDomain: clusterState?.clusterDomain || null,
                    clusterNodes:  enrichedNodes,
                    stats:         clusterDash
                };
            } catch (_) { /* cluster server unreachable */ }
        }

        this.state.nodes = nodes;
        this.state.updatedAt = Date.now();
        this.broadcast({ type: 'stats', data: nodes });
    }

    async _fetchStats(server) {
        const [dash, info] = await Promise.all([
            getDashboard(server),
            getSessionInfo(server)
        ]);
        return {
            name:               server.name,
            url:                server.url,
            version:            info?.version            || 'unknown',
            dnsServerDomain:    info?.dnsServerDomain    || server.name,
            clusterInitialized: info?.clusterInitialized || false,
            clusterDomain:      info?.clusterDomain      || null,
            clusterNodes:       info?.clusterNodes       || null,
            stats:              dash
        };
    }

    async _pollFeed() {
        for (const server of this.servers) {
            try {
                const logs = await getQueryLogs(server, this.cfg.feedPageSize);
                if (!logs) continue;
                const entries = logs.entries || [];
                const cursor  = this.feedCursors[server.name];

                let fresh = entries;
                if (cursor) {
                    if (entries.length > 0 && entries[0].rowNumber < cursor) {
                        // Newest entry is older than cursor — log was reset or rotated
                        console.log(`${server.name}: feed cursor reset (was ${cursor}, latest is ${entries[0].rowNumber})`);
                        fresh = entries;
                    } else {
                        const idx = entries.findIndex(e => e.rowNumber <= cursor);
                        fresh = idx === -1 ? entries : entries.slice(0, idx);
                    }
                }

                if (fresh.length > 0) {
                    this.feedCursors[server.name] = entries[0]?.rowNumber;
                    this.broadcast({ type: 'feed', server: server.name, data: fresh });
                } else if (!cursor && entries.length > 0) {
                    this.feedCursors[server.name] = entries[0]?.rowNumber;
                }
            } catch (err) { console.warn(`[feed] ${server.name}: ${err.message}`); }
        }
    }

    async _pollTop() {
        // Per-server top stats
        for (const server of this.servers) {
            try {
                const [topDomains, topBlocked, topClients] = await Promise.allSettled([
                    getTopStats(server, 'TopDomains',        this.cfg.topLimit),
                    getTopStats(server, 'TopBlockedDomains', this.cfg.topLimit),
                    getTopStats(server, 'TopClients',        this.cfg.topLimit)
                ]);
                this.broadcast({
                    type: 'top',
                    server: server.name,
                    data: {
                        domains: topDomains.status === 'fulfilled' ? (topDomains.value?.topDomains        || []) : [],
                        blocked: topBlocked.status === 'fulfilled' ? (topBlocked.value?.topBlockedDomains || []) : [],
                        clients: topClients.status === 'fulfilled' ? (topClients.value?.topClients        || []) : []
                    }
                });
            } catch (_) { /* ignore */ }
        }

        // Cluster aggregate top stats
        if (this.clusterServer) {
            try {
                const [topDomains, topBlocked, topClients] = await Promise.allSettled([
                    getTopStats(this.clusterServer, 'TopDomains',        this.cfg.topLimit, 'LastHour', 'cluster'),
                    getTopStats(this.clusterServer, 'TopBlockedDomains', this.cfg.topLimit, 'LastHour', 'cluster'),
                    getTopStats(this.clusterServer, 'TopClients',        this.cfg.topLimit, 'LastHour', 'cluster')
                ]);
                this.broadcast({
                    type: 'top',
                    server: CLUSTER_KEY,
                    data: {
                        domains: topDomains.status === 'fulfilled' ? (topDomains.value?.topDomains        || []) : [],
                        blocked: topBlocked.status === 'fulfilled' ? (topBlocked.value?.topBlockedDomains || []) : [],
                        clients: topClients.status === 'fulfilled' ? (topClients.value?.topClients        || []) : []
                    }
                });
            } catch (_) { /* ignore */ }
        }
    }

    async _pollPerformance() {
        for (const server of this.servers) {
            try {
                const rtts = await getRttSample(server, this.cfg.rttSample);
                if (rtts.length === 0) continue;

                // 1. Calculate Jitter (RFC 3550 EWMA)
                // We do this before sorting to maintain temporal order (newest to oldest)
                let j = this._jitterState[server.name] || 0;
                for (let i = 1; i < rtts.length; i++) {
                    j += (Math.abs(rtts[i] - rtts[i - 1]) - j) / 16;
                }
                this._jitterState[server.name] = j;
                const jitter = j;

                // 2. Statistical Metrics (requires sorted array)
                rtts.sort((a, b) => a - b);
                const mean   = rtts.reduce((s, v) => s + v, 0) / rtts.length;
                const median = rtts[Math.floor(rtts.length / 2)];
                const p99    = rtts[Math.min(Math.floor(rtts.length * 0.99), rtts.length - 1)];

                const st = this.state.nodes?.[server.name]?.stats?.stats || {};
                const totalQueries   = st.totalQueries    || 0;
                const totalRecursive = st.totalRecursive   || 0;
                const totalCached    = st.totalCached      || 0;
                const cachedEntries  = st.cachedEntries    || 0;
                const cacheMax       = server.cacheMaxEntries || 0;

                const denominator = totalRecursive + totalCached;
                const hitRate     = denominator > 0 ? (totalCached / denominator) * 100 : 0;
                const impact      = denominator > 0 ? mean * (rtts.length / denominator) : 0;

                const perfData = {
                    rtt: {
                        median:  +median.toFixed(2),
                        mean:    +mean.toFixed(2),
                        p99:     +p99.toFixed(2),
                        jitter:  +jitter.toFixed(2),
                        samples: rtts.length
                    },
                    cache: {
                        hitRate:    +hitRate.toFixed(1),
                        entries:    cachedEntries,
                        maxEntries: cacheMax
                    },
                    impact:       +impact.toFixed(2),
                    recursivePct: totalQueries > 0 ? Math.round(totalRecursive / totalQueries * 100) : 0,
                };

                this.state.perf[server.name] = perfData;

                this.broadcast({
                    type:   'perf',
                    server: server.name,
                    data:   perfData
                });
            } catch (_) { /* unreachable */ }
        }
    }
}

module.exports = Poller;
module.exports.msUntilSafe = msUntilSafe;
module.exports.getUnsafeSeconds = getUnsafeSeconds;
