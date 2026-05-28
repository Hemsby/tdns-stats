'use strict';

const { getDashboard, getTopStats, getQueryLogs, getRttSample, getSessionInfo } = require('./technitium');

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
            topLimit:      cfg?.top?.limit      || 20,
            rttSample:     cfg?.rtt?.sampleSize || 500,
            feedPageSize:  cfg?.feed?.pageSize  || 20,
        };
        this.state     = {};
        this.feedCursors   = {};
        this.clusterServer = null;
        this._statsTimer = null;
        this._feedTimer  = null;
        this._topTimer   = null;
        this._perfTimer  = null;
    }

    start() {
        this._pollStats();
        this._pollFeed();
        this._pollTop();
        this._pollPerformance();
        this._statsTimer = setInterval(() => this._pollStats(),       this.cfg.statsInterval);
        this._feedTimer  = setInterval(() => this._pollFeed(),        this.cfg.feedInterval);
        this._topTimer   = setInterval(() => this._pollTop(),         this.cfg.topInterval);
        this._perfTimer  = setInterval(() => this._pollPerformance(), this.cfg.perfInterval);
    }

    stop() {
        clearInterval(this._statsTimer);
        clearInterval(this._feedTimer);
        clearInterval(this._topTimer);
        clearInterval(this._perfTimer);
    }

    getState() {
        return this.state;
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
                const [clusterDash, sampleNode] = await Promise.all([
                    getDashboard(this.clusterServer, 'LastHour', 'cluster'),
                    Promise.resolve(results.find(r => r.status === 'fulfilled' && r.value.clusterNodes)?.value)
                ]);
                nodes[CLUSTER_KEY] = {
                    clusterDomain: sampleNode?.clusterDomain || null,
                    clusterNodes:  sampleNode?.clusterNodes  || null,
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

                rtts.sort((a, b) => a - b);
                const mean   = rtts.reduce((s, v) => s + v, 0) / rtts.length;
                const median = rtts[Math.floor(rtts.length / 2)];
                const p99    = rtts[Math.min(Math.floor(rtts.length * 0.99), rtts.length - 1)];
                const jitter = Math.max(0, mean - median);

                const st = this.state.nodes?.[server.name]?.stats?.stats || {};
                const totalQueries   = st.totalQueries    || 0;
                const totalRecursive = st.totalRecursive   || 0;
                const totalCached    = st.totalCached      || 0;
                const cachedEntries  = st.cachedEntries    || 0;
                const cacheMax       = server.cacheMaxEntries || 0;

                const denominator = totalRecursive + totalCached;
                const hitRate     = denominator > 0 ? (totalCached / denominator) * 100 : 0;
                const impact      = denominator > 0 ? mean * (rtts.length / denominator) : 0;

                this.broadcast({
                    type:   'perf',
                    server: server.name,
                    data: {
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
                    }
                });
            } catch (_) { /* unreachable */ }
        }
    }
}

module.exports = Poller;
