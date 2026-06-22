'use strict';

const { getDashboard, getTopStats, getQueryLogs, getRttSample, getSessionInfo, getClusterState } = require('./technitium');

const CLUSTER_KEY = '__cluster';

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
            longRangeInterval: 900000,
            topLimit:      cfg?.top?.limit      || 20,
            feedPageSize:  cfg?.feed?.pageSize  || 20,
        };
        this.state     = {};
        this.state.perf  = {};
        this.state.rangeData = {};
        this.feedCursors   = {};
        this._feedPollInProgress = false;
        this.clusterServer = null;
        this._watchedServer = null;
        this._statsTimer = null;
        this._feedTimer  = null;
        this._topTimer   = null;
        this._perfTimer  = null;
        this._rangeTimer = null;
        this._longRangeTimer = null;
        this._running    = false;
        this._rangeRefreshPending = false;
    }

    _clearTimers() {
        clearInterval(this._statsTimer);
        clearInterval(this._feedTimer);
        clearInterval(this._topTimer);
        clearInterval(this._perfTimer);
        clearInterval(this._rangeTimer);
        clearInterval(this._longRangeTimer);
        this._statsTimer = null;
        this._feedTimer  = null;
        this._topTimer   = null;
        this._perfTimer  = null;
        this._rangeTimer = null;
        this._longRangeTimer = null;
        this._running    = false;
    }

    _startTimers() {
        if (this._running) return;
        this._statsTimer = setInterval(() => this._pollStats(),       this.cfg.statsInterval);
        this._feedTimer  = setInterval(() => this._pollFeed(),        this.cfg.feedInterval);
        this._topTimer   = setInterval(() => this._pollTop(),         this.cfg.topInterval);
        this._perfTimer  = setInterval(() => this._pollPerformance(), this.cfg.perfInterval);
        this._rangeTimer = setInterval(() => this._pollRangeData(),   this.cfg.rangeInterval);
        this._longRangeTimer = setInterval(() => this._pollLongRangeData(), this.cfg.longRangeInterval);
        this._running    = true;
    }

    _pollAll() {
        this._pollStats();
        this._pollFeed();
        this._pollTop();
        this._pollPerformance();
        // Range data is fetched on-demand via refreshRangeData() when an SSE
        // client connects — avoids double-fetching on first client after idle.
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

    refreshRangeData() {
        if (this._rangeRefreshPending) return;
        this._rangeRefreshPending = true;
        Promise.allSettled([
            this._pollRangeData(),
            new Promise(r => setTimeout(r, 2500)).then(() => this._pollLongRangeData())
        ]).finally(() => { this._rangeRefreshPending = false; });
    }

    setWatchedServer(name) {
        if (name === CLUSTER_KEY) {
            this._pollRangeData();
            this._pollLongRangeData();
            return;
        }
        if (name === this._watchedServer) return;
        this._watchedServer = name;
        const server = this.servers.find(s => s.name === name);
        if (!server) return;
        this._pollRangeData();
        this._pollLongRangeData();
    }

    getState() {
        return this.state;
    }

    async _fetchRangeData(rangeType, server, isCluster) {
        const node = isCluster ? 'cluster' : null;
        const serverKey = isCluster ? CLUSTER_KEY : server.name;
        try {
            const data = await getDashboard(server, rangeType, node, 0);
            this.state.rangeData[serverKey + ':' + rangeType] = data;
            this.broadcast({ type: 'range-dashboard', range: rangeType, server: serverKey, data });
        } catch (_) { /* ignore */ }

        try {
            const [topDomains, topBlocked, topClients] = await Promise.allSettled([
                getTopStats(server, 'TopDomains',        this.cfg.topLimit, rangeType, node),
                getTopStats(server, 'TopBlockedDomains', this.cfg.topLimit, rangeType, node),
                getTopStats(server, 'TopClients',        this.cfg.topLimit, rangeType, node)
            ]);
            const topData = {
                domains: topDomains.status === 'fulfilled' ? (topDomains.value?.topDomains        || []) : [],
                blocked: topBlocked.status === 'fulfilled' ? (topBlocked.value?.topBlockedDomains || []) : [],
                clients: topClients.status === 'fulfilled' ? (topClients.value?.topClients        || []) : []
            };
            this.state.rangeData[serverKey + ':' + rangeType + ':top'] = topData;
            this.broadcast({ type: 'range-top', range: rangeType, server: serverKey, data: topData });
        } catch (_) { /* ignore */ }
    }

    async _pollRangeData() {
        const primary = this._watchedServer
            ? this.servers.find(s => s.name === this._watchedServer)
            : this.servers[0];
        if (!primary) return;
        await this._fetchRangeData('LastDay', primary, false);
        if (this.clusterServer) await this._fetchRangeData('LastDay', this.clusterServer, true);
    }

    async _pollLongRangeData() {
        const primary = this._watchedServer
            ? this.servers.find(s => s.name === this._watchedServer)
            : this.servers[0];
        if (!primary) return;
        for (const type of ['LastWeek', 'LastMonth', 'LastYear']) {
            await this._fetchRangeData(type, primary, false);
            if (this.clusterServer) await this._fetchRangeData(type, this.clusterServer, true);
        }
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
        if (this._feedPollInProgress) return;
        this._feedPollInProgress = true;
        try { await this._doFeedPoll(); } finally { this._feedPollInProgress = false; }
    }

    async _doFeedPoll() {
        for (const server of this.servers) {
            try {
                const logs = await getQueryLogs(server, this.cfg.feedPageSize);
                if (!logs) continue;
                const entries = logs.entries || [];
                const cursor  = this.feedCursors[server.name];
                let cursorReset = false;

                let fresh = entries;
                if (cursor) {
                    if (entries.length > 0) {
                        const latestTs = new Date(entries[0].timestamp).getTime();
                        if (latestTs < cursor) {
                            // Timestamp went backwards — query log was reset or rotated
                            console.log(`${server.name}: feed cursor reset (before: ${new Date(cursor).toISOString()} → after: ${entries[0].timestamp})`);
                            fresh = entries;
                            cursorReset = true;
                        } else {
                            const idx = entries.findIndex(e => new Date(e.timestamp).getTime() <= cursor);
                            fresh = idx === -1 ? entries : entries.slice(0, idx);
                        }
                    }
                }

                if (fresh.length > 0) {
                    this.feedCursors[server.name] = new Date(entries[0]?.timestamp).getTime();
                    this.broadcast({ type: 'feed', server: server.name, data: fresh, cursorReset });
                } else if (!cursor && entries.length > 0) {
                    this.feedCursors[server.name] = new Date(entries[0]?.timestamp).getTime();
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
                const st = this.state.nodes?.[server.name]?.stats?.stats || {};
                const totalRecursive = st.totalRecursive || 0;

                // No stats yet or zero recursive in the last hour — nothing to compute
                if (!totalRecursive) {
                    delete this.state.perf[server.name];
                    this.broadcast({ type: 'perf', server: server.name, data: null });
                    continue;
                }

                const sampleSize = Math.min(totalRecursive, 500);
                const rtts = await getRttSample(server, sampleSize);
                if (rtts.length === 0) {
                    delete this.state.perf[server.name];
                    this.broadcast({ type: 'perf', server: server.name, data: null });
                    continue;
                }

                // 1. Calculate Jitter (RFC 3550 EWMA)
                // Computed fresh each cycle from the current batch's temporal order (newest to oldest)
                let j = 0;
                for (let i = 1; i < rtts.length; i++) {
                    j += (Math.abs(rtts[i] - rtts[i - 1]) - j) / 16;
                }
                const jitter = j;

                // 2. Statistical Metrics (requires sorted array)
                rtts.sort((a, b) => a - b);
                const mean   = rtts.reduce((s, v) => s + v, 0) / rtts.length;
                const median = rtts[Math.floor(rtts.length / 2)];
                const p99    = rtts[Math.min(Math.floor(rtts.length * 0.99), rtts.length - 1)];

                const totalQueries  = st.totalQueries   || 0;
                const totalCached   = st.totalCached     || 0;
                const cachedEntries = st.cachedEntries   || 0;
                const cacheMax      = server.cacheMaxEntries || 0;

                const denominator = totalRecursive + totalCached;
                const hitRate     = denominator > 0 ? (totalCached / denominator) * 100 : 0;
                const impact      = denominator > 0 ? mean * (rtts.length / denominator) : 0;

                const perfData = {
                    rtt: {
                        median:  +median.toFixed(2),
                        mean:    +mean.toFixed(2),
                        p99:     +p99.toFixed(2),
                        jitter:  +jitter.toFixed(2),
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
