'use strict';

const http = require('http');

const { buildTechnitiumData, aggregateCluster, cacheForDomain } = require('./technitium-data-gen');

/**
 * An in-process mock of a Technitium DNS server.
 *
 * It is a real HTTP server on an ephemeral port, not a stubbed fetch, so the
 * tests exercise the real transport: the Authorization header, the status
 * codes, the JSON envelopes Technitium uses and the retry path.
 *
 * Every request is recorded so a test can assert on what was actually asked
 * for (which is often the point: "the poller asked for the top list with the
 * right statsType and limit").
 *
 * options:
 *   info         - the object returned under `info` by /api/user/session/get
 *   settings     - the object returned by /api/settings/get
 *   apps         - the `apps` array returned by /api/apps/list
 *   dashboard    - the object returned by /api/dashboard/stats/get
 *   topStats     - map of statsType -> object returned by /api/dashboard/stats/getTop
 *   logEntries   - the `entries` array returned by /api/logs/query
 *   clusterState - the object returned by /api/admin/cluster/state, or a
 *                  function () => object when it depends on the other nodes
 *   cache        - the cache the node holds, as the names it holds them for.
 *                  /api/cache/list answers from it, the way a real server
 *                  answers with the records of the name that was asked for
 *                  and the zones under it.
 *   dnsClient    - the object returned by /api/dnsClient/resolve
 *   resolve      - a function (query) => the object returned by
 *                  /api/dnsClient/resolve, when the answer depends on the
 *                  name or the type asked for
 *   logEntries   - the `entries` array returned by /api/logs/query, or a
 *                  function (query) => entries, so a live log can be built around
 *                  the time of the request
 *   cluster      - the nodes of the cluster this server belongs to, as
 *                  () => [{ name, state }]. A request for another node is
 *                  answered with that node's data and a request for the
 *                  cluster with the totals of every node, the way a real
 *                  cluster answers both.
 */
function createTechnitiumServer(options = {}) {
    // Without options the mock answers like a real Technitium server: the
    // same counts, the same shapes, a live query log. A test that only needs
    // one field passes just that field, and the rest stays realistic.
    const defaults = buildTechnitiumData();
    const state = {
        info: options.info ?? defaults.info,
        settings: options.settings ?? defaults.settings,
        apps: options.apps ?? defaults.apps,
        dashboard: options.dashboard ?? defaults.dashboard,
        topStats: options.topStats ?? defaults.topStats,
        logEntries: options.logEntries ?? defaults.logEntries,
        clusterState: options.clusterState ?? defaults.clusterState,
        cache: options.cache ?? defaults.cache,
        dnsClient: options.dnsClient ?? defaults.dnsClient,
        // A caller that brings its own answer for a name uses it as it is.
        resolve: options.resolve ?? (options.dnsClient ? null : defaults.resolve),
        // path prefix -> { status, body }. A matched path answers with the
        // given status instead of the normal envelope.
        fail: {},
        requests: [],
        cluster: options.cluster || null,
    };

    /**
     * The node a request names, or null when it names none.
     *
     * A request for the cluster is not a node: it is answered with the
     * totals of every node, so it is handled by the caller.
     */
    function namedNode(node) {
        if (!node || !state.cluster) return null;
        const wanted = String(node).toLowerCase();
        if (wanted === 'cluster') return null;
        return state.cluster().find(n => String(n.name).toLowerCase() === wanted) || null;
    }

    /** The totals of every node of the cluster. */
    function clusterTotals() {
        const nodes = state.cluster ? state.cluster() : [];
        return aggregateCluster(nodes.map(node => ({ dashboard: node.state.dashboard, topStats: node.state.topStats })));
    }

    function isClusterRequest(node) {
        return String(node || '').toLowerCase() === 'cluster';
    }

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname;
        const query = Object.fromEntries(url.searchParams.entries());

        state.requests.push({
            method: req.method,
            path,
            query,
            headers: req.headers,
        });

        for (const [prefix, failure] of Object.entries(state.fail)) {
            if (!path.startsWith(prefix)) continue;
            res.writeHead(failure.status || 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(failure.body ?? { status: 'error', errorMessage: 'failed' }));
            return;
        }

        let body;
        switch (path) {
            // Technitium returns the session info at the top level, not under `response`.
            case '/api/user/session/get':
                body = { status: 'ok', info: state.info };
                break;
            case '/api/settings/get':
                body = { status: 'ok', response: state.settings };
                break;
            case '/api/apps/list':
                // The server lists its apps by name.
                body = { status: 'ok', response: { apps: [...state.apps].sort((a, b) => String(a.name).localeCompare(String(b.name))) } };
                break;
            case '/api/admin/cluster/state':
                body = { status: 'ok', response: typeof state.clusterState === 'function' ? state.clusterState() : state.clusterState };
                break;
            case '/api/cache/list': {
                // A real server answers with what it holds for the name that
                // was asked for, so a name it never cached comes back empty.
                const domain = String(query.domain || '');
                const direction = String(query.direction || 'down');
                body = { status: 'ok', response: cacheForDomain(state.cache, domain, direction) };
                break;
            }
            case '/api/dnsClient/resolve':
                body = { status: 'ok', response: state.resolve ? state.resolve(query) : state.dnsClient };
                break;
            case '/api/dashboard/stats/get': {
                const target = namedNode(query.node);
                const dashboard = isClusterRequest(query.node)
                    ? clusterTotals().dashboard
                    : target
                      ? target.state.dashboard
                      : state.dashboard;
                body = { status: 'ok', response: dashboard };
                break;
            }
            case '/api/dashboard/stats/getTop': {
                const target = namedNode(query.node);
                const source = isClusterRequest(query.node) ? clusterTotals().topStats : target ? target.state.topStats : state.topStats;
                const top = source[query.statsType] ?? {};
                // Technitium answers with as many rows as were asked for.
                const limit = Number(query.limit) || 0;
                const trimmed = {};
                for (const [key, rows] of Object.entries(top)) {
                    trimmed[key] = limit > 0 && Array.isArray(rows) ? rows.slice(0, limit) : rows;
                }
                body = { status: 'ok', response: trimmed };
                break;
            }
            case '/api/logs/query': {
                const target = namedNode(query.node);
                const source = target ? target.state.logEntries : state.logEntries;
                const all = typeof source === 'function' ? source() : source;
                // The RTT sample asks for recursive answers only.
                const entries = query.responseType ? all.filter(e => e.responseType === query.responseType) : all;
                // Only the count-lists reader asks for a page; the live feed
                // asks for a single batch.
                const perPage = Number(query.entriesPerPage) || 0;
                const batch = query.pageNumber
                    ? entries.slice((Number(query.pageNumber) - 1) * perPage, Number(query.pageNumber) * perPage)
                    : perPage
                      ? entries.slice(0, perPage)
                      : entries;
                body = {
                    status: 'ok',
                    response: {
                        entries: batch,
                        totalPages: Math.max(1, Math.ceil(entries.length / Number(query.entriesPerPage || entries.length || 1))),
                        totalEntries: entries.length,
                    },
                };
                break;
            }
            default:
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', errorMessage: 'not found' }));
                return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    });

    return {
        state,
        requests: state.requests,
        get url() {
            return `http://127.0.0.1:${server.address().port}`;
        },
        start(port = 0) {
            return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(this)));
        },
        stop() {
            return new Promise(resolve => server.close(resolve));
        },
        /** Make every request under `prefix` fail with `status`. */
        fail(prefix, status = 500) {
            state.fail[prefix] = { status };
        },
        /** Replace the query log entries the server hands out. */
        setLogEntries(entries) {
            state.logEntries = entries;
        },
        /**
         * A server object shaped the way technitium.js expects it, pointed at
         * this mock server.
         */
        serverConfig(name = 'ns1', extra = {}) {
            return {
                name,
                url: this.url,
                token: 'test-token',
                ignoreSsl: false,
                queryLogsAppName: null,
                queryLogsApp: null,
                ...extra,
            };
        },
    };
}

module.exports = { createTechnitiumServer };
