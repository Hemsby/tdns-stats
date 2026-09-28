'use strict';

const { getDashboard, getTopStats, getQueryLogs, getRttSample, getSessionInfo, getClusterState, getClusterNodeState, certVerificationHint } = require('./technitium');

const CLUSTER_KEY = '__cluster';

// How many minutes of mean recursive RTT to keep for the real-time chart overlay.
const RTT_HISTORY_MINUTES = 60;

// Floor an ISO timestamp to its UTC minute, matching the label format that
// normalizeLabels() produces for the LastHour chart so the frontend can align
// the RTT series directly against the chart's x-axis labels.
function minuteKey(ts) {
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return null;
    d.setUTCSeconds(0, 0);
    return d.toISOString();
}

function pruneRttHistory(map) {
    const cutoff = Date.now() - (RTT_HISTORY_MINUTES + 5) * 60000;
    for (const key of map.keys()) {
        if (new Date(key).getTime() < cutoff) map.delete(key);
    }
}

function rttHistoryToSeries(map) {
    return [...map.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([t, v]) => ({ t, mean: +v.mean.toFixed(2) }));
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
            longRangeInterval: 900000,
            topLimit:      cfg?.top?.limit      || 20,
            feedPageSize:  cfg?.feed?.pageSize  || 20,
        };
        this.state     = {};
        this.state.perf  = {};
        this.state.rttSeries = {}; // serialized mean-recursive-RTT history per server + __cluster
        this.rttHistory = {};      // source of truth: key -> Map(minuteISO -> { mean, n })
        this.feedCursors   = {};
        this._feedPollBusy = new Set();
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

    async _pollAll() {
        this._pollStats();
        await this._pollFeed();
        this._pollTop();
        await this._pollPerformance();
        // Range data is fetched on-demand via refreshRangeData() when an SSE
        // client connects — avoids double-fetching on first client after idle.
    }

    start() {
        this._pollAll();
        this._startTimers();
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

    async _fetchRangeData(rangeType, server, isCluster, skipTop = false) {
        const node = isCluster ? 'cluster' : null;
        const serverKey = isCluster ? CLUSTER_KEY : server.name;
        try {
            const data = await getDashboard(server, rangeType, node, 0);
            this.broadcast({ type: 'range-dashboard', range: rangeType, server: serverKey, data });
        } catch (_) { /* ignore */ }

        if (skipTop) return;

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
            this.broadcast({ type: 'range-top', range: rangeType, server: serverKey, data: topData });
        } catch (_) { /* ignore */ }
    }

    async _pollRangeData() {
        const watched = this._watchedServer
            ? this.servers.find(s => s.name === this._watchedServer)
            : this.servers[0];
        if (!watched) return;
        for (const server of this.servers) {
            await this._fetchRangeData('LastDay', server, false, server !== watched);
        }
        if (this.clusterServer) await this._fetchRangeData('LastDay', this.clusterServer, true);
    }

    async _pollLongRangeData() {
        const watched = this._watchedServer
            ? this.servers.find(s => s.name === this._watchedServer)
            : this.servers[0];
        if (!watched) return;
        for (const type of ['LastWeek', 'LastMonth', 'LastYear']) {
            for (const server of this.servers) {
                await this._fetchRangeData(type, server, false, server !== watched);
            }
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
            if (r.status === 'fulfilled') {
                nodes[key] = r.value;
                return;
            }
            console.warn(`[stats] ${key}: ${r.reason?.message}${certVerificationHint(r.reason)}`);
            nodes[key] = { error: r.reason?.message };
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

                // Query each node individually to get its configLastSynced. node.url is the
                // node's own cluster-sync URL, which Technitium requires to be HTTPS regardless
                // of how the admin API itself is configured - see getClusterNodeState for why
                // this needs its own verify-then-fallback handling instead of plain getClusterState.
                const enrichedNodes = await Promise.all(
                    (clusterState?.clusterNodes || []).map(async node => {
                        try {
                            const nodeState = await getClusterNodeState({ ...this.clusterServer, url: node.url });
                            // Find this node's entry in the response to get its configLastSynced
                            const selfNode = (nodeState?.clusterNodes || []).find(n => n.id === node.id || n.name === node.name);
                            return {
                                ...node,
                                configLastSynced: selfNode?.configLastSynced || null
                            };
                        } catch (err) {
                            console.warn(`[cluster] ${node.name || node.url}: ${err.message}`);
                            return { ...node, configLastSynced: null };
                        }
                    })
                );

                nodes[CLUSTER_KEY] = {
                    clusterDomain: clusterState?.clusterDomain || null,
                    clusterNodes:  enrichedNodes,
                    stats:         clusterDash
                };
            } catch (_) {
                this.clusterServer = null; // allow re-election on next poll
            }
        }

        this.state.nodes = nodes;
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
            stats:              dash,
            queryLogsApp:       server.queryLogsApp?.name || null,
            queryLogsAppName:   server.queryLogsAppName    || null,
        };
    }

    async _pollFeed() {
        const tasks = [];
        for (const server of this.servers) {
            if (this._feedPollBusy.has(server.name)) continue;
            this._feedPollBusy.add(server.name);
            tasks.push(
                this._pollOneFeed(server)
                    .catch(err => console.warn(`[feed] ${server.name}: ${err.message}`))
                    .finally(() => this._feedPollBusy.delete(server.name))
            );
        }
        if (tasks.length === 0) return;
        await Promise.allSettled(tasks);
    }

    async _pollOneFeed(server) {
        const logs = await getQueryLogs(server, this.cfg.feedPageSize);
        if (!logs) return;
        const toMs = (e) => new Date(e.timestamp).getTime();
        const validMs = (e) => {
            const t = toMs(e);
            if (!Number.isFinite(t)) {
                console.warn(`[feed] ${server.name}: row ${e.rowNumber} has invalid timestamp: ${e.timestamp}`);
                return false;
            }
            return true;
        };

        const entries = (logs.entries || []).filter(validMs);
        if (entries.length === 0) return;

        entries.sort((a, b) => {
            const dt = toMs(b) - toMs(a);
            return dt !== 0 ? dt : (b.rowNumber ?? 0) - (a.rowNumber ?? 0);
        });

        const cursor = this.feedCursors[server.name];
        let cursorReset = false;

        const newestTs        = toMs(entries[0]);
        const newestRowNumber = entries[0].rowNumber;

        if (!cursor) {
            this.feedCursors[server.name] = { ts: newestTs, rowNumber: newestRowNumber };
            this.broadcast({ type: 'feed', server: server.name, data: entries, cursorReset });
            return;
        }

        const isReset = newestTs < cursor.ts;
        let fresh;
        if (isReset) {
            console.log(
                `[feed] ${server.name}: feed cursor reset ` +
                `(before: ts=${new Date(cursor.ts).toISOString()} row=${cursor.rowNumber} ` +
                `→ after: ts=${entries[0].timestamp} row=${newestRowNumber})`
            );
            fresh = entries;
            cursorReset = true;
        } else {
            fresh = entries.filter(e => {
                if (e.rowNumber == null) return true;
                const t = toMs(e);
                if (!Number.isFinite(t)) return false;
                return t > cursor.ts || (t === cursor.ts && e.rowNumber > cursor.rowNumber);
            });
        }

        if (fresh.length === 0) return;

        this.feedCursors[server.name] = { ts: newestTs, rowNumber: newestRowNumber };
        this.broadcast({ type: 'feed', server: server.name, data: fresh, cursorReset });
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
        const results = await Promise.allSettled(
            this.servers.map(server => this._pollOnePerf(server))
        );
        this._updateClusterRtt(results);
    }

    async _pollOnePerf(server) {
        try {
            const st = this.state.nodes?.[server.name]?.stats?.stats || {};
            const totalRecursive = st.totalRecursive || 0;

            // No stats yet or zero recursive in the last hour — nothing to compute
            if (!totalRecursive) {
                delete this.state.perf[server.name];
                this.broadcast({ type: 'perf', server: server.name, data: null });
                return null;
            }

            const sampleSize = Math.min(totalRecursive, 500);
            const sample = await getRttSample(server, sampleSize);
            if (sample.length === 0) {
                delete this.state.perf[server.name];
                this.broadcast({ type: 'perf', server: server.name, data: null });
                return null;
            }

            // RTT values in the query log's own order (newest to oldest). Keep this
            // array untouched for the jitter calc; sort a copy for the percentiles.
            const vals = sample.map(s => s.rtt);

            // Calculate Jitter (EWMA of RTT variation)
            // Measures how much response times vary between consecutive queries
            let jitter = null;
            if (vals.length >= 2) {
                let j = 0;
                for (let i = 1; i < vals.length; i++) {
                    j += (Math.abs(vals[i] - vals[i - 1]) - j) / 16;
                }
                jitter = j;
            }

            // Per-minute mean RTT buckets for the real-time chart overlay, keyed by
            // each entry's own timestamp rather than poll wall-clock. On a busy server
            // the whole sample lands in one minute; on a quiet one the first poll
            // backfills up to an hour of real history.
            const buckets = new Map();
            for (const { t, rtt } of sample) {
                const key = minuteKey(t);
                if (!key) continue;
                const b = buckets.get(key) || { sum: 0, n: 0 };
                b.sum += rtt;
                b.n += 1;
                buckets.set(key, b);
            }
            const history = this.rttHistory[server.name] || (this.rttHistory[server.name] = new Map());
            for (const [key, b] of buckets) history.set(key, { mean: b.sum / b.n, n: b.n });
            pruneRttHistory(history);
            this.state.rttSeries[server.name] = rttHistoryToSeries(history);
            this.broadcast({ type: 'perf-series', server: server.name, data: this.state.rttSeries[server.name] });

            // Statistical Metrics (sorted copy; never sort `sample`/`vals`)
            const sorted = [...vals].sort((a, b) => a - b);
            const n      = sorted.length;
            const mean   = sorted.reduce((s, v) => s + v, 0) / n;
            const mid    = Math.floor(n / 2);
            const median = n >= 3 ? (n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]) : null;
            const pctl   = p => (n >= 3 ? sorted[Math.min(Math.floor(n * p), n - 1)] : null);
            const p95    = pctl(0.95);
            const p99    = pctl(0.99);

            const totalCached   = st.totalCached     || 0;
            const cachedEntries = st.cachedEntries   || 0;
            const cacheMax      = server.cacheMaxEntries || 0;

            const denominator = totalRecursive + totalCached;
            const hitRate     = denominator > 0 ? (totalCached / denominator) * 100 : 0;
            const impact      = denominator > 0 ? mean * (n / denominator) : 0;

            const perfData = {
                rtt: {
                    median:  median != null ? +median.toFixed(2) : null,
                    mean:    +mean.toFixed(2),
                    p95:     p95 != null ? +p95.toFixed(2) : null,
                    p99:     p99 != null ? +p99.toFixed(2) : null,
                    jitter:  jitter != null ? +jitter.toFixed(2) : null,
                },
                cache: {
                    hitRate:    +hitRate.toFixed(1),
                    entries:    cachedEntries,
                    maxEntries: cacheMax
                },
                impact:       +impact.toFixed(2),
            };

            this.state.perf[server.name] = perfData;

            this.broadcast({
                type:   'perf',
                server: server.name,
                data:   perfData
            });

            return { name: server.name, buckets };
        } catch (err) {
            console.warn(`[perf] ${server.name}: ${err.message}`);
            delete this.state.perf[server.name];
            this.broadcast({ type: 'perf', server: server.name, data: null });
            return null;
        }
    }

    // Cluster mean recursive RTT: pool every node's per-minute sample sums so the
    // combined mean is entry-count weighted, then merge into the __cluster history.
    _updateClusterRtt(results) {
        if (!this.clusterServer) return;

        const pooled = new Map();
        for (const r of results) {
            if (r.status !== 'fulfilled' || !r.value?.buckets) continue;
            for (const [key, b] of r.value.buckets) {
                const c = pooled.get(key) || { sum: 0, n: 0 };
                c.sum += b.sum;
                c.n += b.n;
                pooled.set(key, c);
            }
        }
        if (pooled.size === 0) return;

        const history = this.rttHistory[CLUSTER_KEY] || (this.rttHistory[CLUSTER_KEY] = new Map());
        for (const [key, c] of pooled) history.set(key, { mean: c.sum / c.n, n: c.n });
        pruneRttHistory(history);
        this.state.rttSeries[CLUSTER_KEY] = rttHistoryToSeries(history);
        this.broadcast({ type: 'perf-series', server: CLUSTER_KEY, data: this.state.rttSeries[CLUSTER_KEY] });
    }
}

module.exports = Poller;
