'use strict';

const CLUSTER_KEY = '__cluster';

const App = (() => {
    const state = {
        nodes:         {},
        top:           {},
        perf:          {},
        rangeCache:    {}, // keyed by "server:type" for non-LiveHour fetches
        serverNames:   [],
        serverColorMap: {},
        colorMap:      {},
        activeTab:     null,
        chartServer:   null,
        topServer:     null,
        topTab:        'domains',
        feedServer:    'all',
        feedFilters:   new Set(),
        feedPaused:    false,
        lastFeedEvent: null,
        timeRange:     'LastHour',
        connected:     false,
        lastUpdated:   null,
        isCluster:     false,
        version:       null,
        updateAvailable: false,
        updateStatus:  null,
        healthCheckTimer: null,
        domainSearchServer: 'all',
        blockedLookup: false,
    };

    let es = null;

    // ---- SSE ----------------------------------------------------------------
    let reconnectTimer = null;
    let currentReconnectDelay = 3000;
    let lastConnectAttempt = 0;

    function reconnectWithCountdown(delayMs) {
        // Clear any existing timer to prevent overlapping loops
        if (reconnectTimer) clearInterval(reconnectTimer);
        
        currentReconnectDelay = delayMs;
        let secondsLeft = Math.ceil(delayMs / 1000);

        function updateCountdown() {
            const statusEl = document.getElementById('lastUpdated');
            if (statusEl) statusEl.textContent = `Reconnecting in ${secondsLeft}s...`;
            secondsLeft--;

            if (secondsLeft < 0) {
                clearInterval(reconnectTimer);
                reconnectTimer = null;
                connect();
            }
        }

        updateCountdown();
        reconnectTimer = setInterval(updateCountdown, 1000);
    }

    function connect() {
        // Cooldown: prevent rapid cycling (at most once every 2 seconds)
        const now = Date.now();
        if (now - lastConnectAttempt < 2000) {
            console.warn('[sse] Connect attempt blocked by cooldown');
            return;
        }
        lastConnectAttempt = now;

        if (es) {
            es.close();
            es = null;
        }

        // Clear any pending reconnect timers
        if (reconnectTimer) {
            clearInterval(reconnectTimer);
            reconnectTimer = null;
        }

        es = new EventSource('/api/stream');

        // Timeout: if we don't get connected within 5 seconds, retry
        const connectTimeout = setTimeout(() => {
            if (!state.connected && es) {
                console.warn('[sse] Connection timeout, retrying...');
                es.close();
                es = null;
                reconnectWithCountdown(currentReconnectDelay);
            }
        }, 5000);

        let lastMsg = Date.now();
        const stalenessTimer = setInterval(() => {
            // Skip staleness check during updates
            if (state.updateStatus === 'updating' || state.updateStatus === 'restarting' || state.updateStatus === 'reconnecting') return;
            
            if (Date.now() - lastMsg > 60000) {
                console.warn('[sse] Connection stale (60s), restarting...');
                clearInterval(stalenessTimer);
                setConnDot('error');
                if (es) { es.close(); es = null; }
                reconnectWithCountdown(3000);
            }
        }, 20000);

        es.onopen = () => {
            clearTimeout(connectTimeout);
            state.connected = true;
            setConnDot('connected');
            document.getElementById('lastUpdated').textContent = 'Connected';
        };

        es.onerror = (err) => {
            console.error('[sse] Stream error:', err);
            clearInterval(stalenessTimer);
            clearTimeout(connectTimeout);
            state.connected = false;
            setConnDot('error');
            
            if (es) { es.close(); es = null; }

            // If an update is in progress, pollHealth handles the reconnection via reload.
            if (state.updateStatus === 'updating' || state.updateStatus === 'restarting' || state.updateStatus === 'reconnecting') {
                return;
            }

            reconnectWithCountdown(3000);
        };

        es.onmessage = evt => {
            lastMsg = Date.now();
            let msg;
            try { msg = JSON.parse(evt.data); } catch (_) { return; }
            handleMessage(msg);
        };
    }

    function handleMessage(msg) {
        if (msg.type === 'stats') {
            state.nodes = msg.data;
            state.lastUpdated = new Date();

            const names = Object.keys(state.nodes).filter(k => k !== CLUSTER_KEY);
            const wasCluster = state.isCluster;
            state.isCluster = !!state.nodes[CLUSTER_KEY];

            if (names.length > 0 && (state.serverNames.join(',') !== names.join(',') || wasCluster !== state.isCluster)) {
                state.serverNames = names;
                const defaultTab = state.isCluster ? CLUSTER_KEY : names[0];
                if (!state.activeTab) state.activeTab = defaultTab;
                const chartFallback = state.isCluster ? CLUSTER_KEY : names[0];
                if (!state.chartServer) state.chartServer = chartFallback;
                if (!state.topServer)   state.topServer   = chartFallback;
                buildServerUI();
                renderPerfCards(); // show placeholders immediately on first server discovery

                // Populate chart and top list data immediately, without waiting for first poll
                refreshChart();
                refreshTopLists(true);
            }

            renderClusterCards();
            renderServerIndicators();
            updateLastUpdated();
            // Only push live chart updates when on LastHour (SSE data is always LastHour)
            if (state.timeRange === 'LastHour') {
                Charts.update(state.nodes, state.chartServer, getDatasetMode());
            }

        } else if (msg.type === 'feed') {
            state.lastFeedEvent = Date.now();
            setFeedStall(false);
            Feed.add(msg.server, msg.data);
            Feed.scheduleRender(state.feedServer, state.feedFilters);

        } else if (msg.type === 'top') {
            state.top[msg.server] = msg.data;
            if (msg.server === state.topServer && state.timeRange === 'LastHour') renderTopLists();

        } else if (msg.type === 'perf') {
            state.perf[msg.server] = msg.data;
            if (state.activeTab === msg.server) {
                renderClusterCards();
            } else {
                renderPerfCards();
            }
        } else if (msg.type === 'update-status') {
            handleUpdateStatus(msg.data);
        } else if (msg.type === 'ping') {
            // No action needed, handleMessage already updated lastMsg
        }
    }

    // ---- Server UI (tabs + selects) -----------------------------------------
    function buildServerUI() {
        state.colorMap = buildColorMap();
        Feed.setColors(state.colorMap);
        buildTabs();
        buildSelects();
    }

    function getElement(id) {
        return document.getElementById(id);
    }

    function populateSelect(id, options, selectedValue) {
        const sel = getElement(id);
        if (!sel) return;
        sel.innerHTML = '';
        for (const option of options) {
            const opt = document.createElement('option');
            opt.value = option.value;
            opt.textContent = option.label;
            sel.appendChild(opt);
        }
        if (selectedValue != null) sel.value = selectedValue;
    }

    function serverColor(key) {
        if (!key) return '';
        if (key === 'all' || key === CLUSTER_KEY) return 'blue';
        return state.colorMap[key] || '';
    }

    function buildTabs() {
        const nav = document.getElementById('serverTabs');
        nav.innerHTML = '';

        if (state.isCluster) {
            nav.appendChild(makeTab('Cluster', CLUSTER_KEY));
        } else {
            nav.appendChild(makeTab('All Servers', 'all'));
        }

        for (const name of state.serverNames) {
            nav.appendChild(makeTab(name, name));
        }

        // Ensure activeTab is still valid
        const validKeys = [state.isCluster ? CLUSTER_KEY : 'all', ...state.serverNames];
        if (!validKeys.includes(state.activeTab)) {
            state.activeTab = validKeys[0];
        }

        nav.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b.dataset.key === state.activeTab));
    }

    function makeTab(label, key) {
        const btn = document.createElement('button');
        btn.className = 'stab' + (state.activeTab === key ? ' active' : '');
        btn.dataset.key = key;

        const color = serverColor(key);
        if (color) {
            const dot = document.createElement('span');
            dot.className = 'tab-dot ' + color;
            btn.appendChild(dot);
        }
        btn.appendChild(document.createTextNode(label));
        btn.addEventListener('click', () => setActiveTab(key));
        return btn;
    }

    function setActiveTab(key) {
        state.activeTab = key;

        if (key === CLUSTER_KEY) {
            state.chartServer = CLUSTER_KEY;
            state.topServer   = CLUSTER_KEY;
            state.feedServer  = 'all';
        } else if (key === 'all') {
            state.chartServer = state.serverNames[0] || null;
            state.topServer   = state.serverNames[0] || null;
            state.feedServer  = 'all';
        } else {
            state.chartServer = key;
            state.topServer   = key;
            state.feedServer  = key;
        }

        document.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b.dataset.key === key));
        syncSelects();
        loadAndApplyFeedFilters();
        renderClusterCards();
        refreshChart();
        refreshTopLists();
        renderPerfCards();
        Feed.render(state.feedServer, state.feedFilters);
    }

    function buildColorMap() {
        const fallback = ['blue', 'green', 'ora', 'pur', 'teal', 'yel'];
        const map = {};
        state.serverNames.forEach((name, i) => {
            map[name] = state.serverColorMap[name] || fallback[i % fallback.length];
        });
        return map;
    }

    function buildSelects() {
        const clusterOption = state.isCluster ? [{ value: CLUSTER_KEY, label: 'Cluster (aggregate)' }] : [];
        const serverOptions = state.serverNames.map(n => ({ value: n, label: n }));

        ['chartServerSelect', 'topServerSelect'].forEach(id => {
            populateSelect(id, [...clusterOption, ...serverOptions], state[id === 'chartServerSelect' ? 'chartServer' : 'topServer']);
            injectSelDot(id);
        });

        populateSelect('feedServerSelect', [{ value: 'all', label: 'All servers' }, ...serverOptions], state.feedServer);
        injectSelDot('feedServerSelect');

        buildDomainSearchSelect();

        syncSelects();
        addSelectListeners();
    }

    function buildDomainSearchSelect() {
        const preferred = state.domainSearchServer || 'all';
        const options = state.isCluster
            ? [{ value: CLUSTER_KEY, label: 'Cluster (all nodes)' }]
            : [{ value: 'all', label: 'All servers' }];

        for (const n of state.serverNames) options.push({ value: n, label: n });

        const selected = options.some(o => o.value === preferred)
            ? preferred
            : options[0]?.value || 'all';

        populateSelect('domainSearchServerSelect', options, selected);
        state.domainSearchServer = selected;
    }

    function injectSelDot(selectId) {
        const sel = document.getElementById(selectId);
        if (!sel) return;
        const dotId = selectId + 'Dot';
        if (!document.getElementById(dotId)) {
            const dot = document.createElement('span');
            dot.id = dotId;
            dot.className = 'sel-dot';
            sel.parentNode.insertBefore(dot, sel);
        }
    }

    function updateSelDot(selectId, key) {
        const dot = document.getElementById(selectId + 'Dot');
        if (!dot) return;
        const color = serverColor(key);
        dot.className = 'sel-dot' + (color ? ' ' + color : '');
    }

    function syncSelects() {
        const cs = document.getElementById('chartServerSelect');
        if (cs) { cs.value = state.chartServer || ''; updateSelDot('chartServerSelect', state.chartServer); }
        const ts = document.getElementById('topServerSelect');
        if (ts) { ts.value = state.topServer || ''; updateSelDot('topServerSelect', state.topServer); }
        const fs = document.getElementById('feedServerSelect');
        if (fs) { fs.value = state.feedServer; updateSelDot('feedServerSelect', state.feedServer); }
    }

    function loadAndApplyFeedFilters() {
        state.feedFilters = loadFeedFilters(state.feedServer);
        document.querySelectorAll('.feed-filter-check').forEach(cb => {
            cb.checked = state.feedFilters.has(cb.value);
        });
    }

    let listenersAdded = false;
    function addSelectListeners() {
        if (listenersAdded) return;
        listenersAdded = true;

        const el = id => document.getElementById(id);

        el('timeRangeSelect') && (el('timeRangeSelect').onchange = e => {
            state.timeRange = e.target.value;
            updateChartHeading();
            refreshChart();
            refreshTopLists();
            if (state.timeRange === 'LastDay') {
                startLastDayRefresh();
            } else {
                stopLastDayRefresh();
            }
        });
        el('chartServerSelect') && (el('chartServerSelect').onchange = e => {
            state.chartServer = e.target.value;
            updateSelDot('chartServerSelect', state.chartServer);
            refreshChart();
        });
        el('chartDatasetSelect') && (el('chartDatasetSelect').onchange = () => {
            refreshChart();
        });

        el('topServerSelect') && (el('topServerSelect').onchange = e => {
            state.topServer = e.target.value;
            updateSelDot('topServerSelect', state.topServer);
            refreshTopLists();
            state.feedServer = e.target.value === CLUSTER_KEY ? 'all' : e.target.value;
            const feedSel = el('feedServerSelect');
            if (feedSel) feedSel.value = state.feedServer;
            updateSelDot('feedServerSelect', state.feedServer);
            loadAndApplyFeedFilters();
            Feed.render(state.feedServer, state.feedFilters);
        });
        el('feedServerSelect') && (el('feedServerSelect').onchange = e => {
            state.feedServer = e.target.value;
            updateSelDot('feedServerSelect', state.feedServer);
            loadAndApplyFeedFilters();
            Feed.render(state.feedServer, state.feedFilters);
        });
        el('domainSearchServerSelect') && (el('domainSearchServerSelect').onchange = e => {
            state.domainSearchServer = e.target.value;
        });
        loadAndApplyFeedFilters();

        const feedFilterBtn = el('feedFilterBtn');
        const feedFilterMenu = el('feedFilterMenu');
        if (feedFilterBtn) {
            feedFilterBtn.addEventListener('click', () => {
                feedFilterMenu.hidden = !feedFilterMenu.hidden;
            });
        }
        document.addEventListener('click', e => {
            if (feedFilterMenu && !feedFilterMenu.contains(e.target) && feedFilterBtn && !feedFilterBtn.contains(e.target)) {
                feedFilterMenu.hidden = true;
            }
        });
        document.querySelectorAll('.feed-filter-check').forEach(cb => {
            cb.addEventListener('change', e => {
                if (e.target.checked) {
                    state.feedFilters.add(e.target.value);
                } else {
                    state.feedFilters.delete(e.target.value);
                }
                saveFeedFilters(state.feedServer, state.feedFilters);
                Feed.render(state.feedServer, state.feedFilters);
            });
        });
        el('feedFilterAll') && el('feedFilterAll').addEventListener('click', () => {
            document.querySelectorAll('.feed-filter-check').forEach(cb => { cb.checked = true; state.feedFilters.add(cb.value); });
            saveFeedFilters(state.feedServer, state.feedFilters);
            Feed.render(state.feedServer, state.feedFilters);
        });
        el('feedFilterNone') && el('feedFilterNone').addEventListener('click', () => {
            state.feedFilters.clear();
            document.querySelectorAll('.feed-filter-check').forEach(cb => { cb.checked = false; });
            saveFeedFilters(state.feedServer, state.feedFilters);
            Feed.render(state.feedServer, state.feedFilters);
        });

        const ICON_PAUSE = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M5.5 3.5A1.5 1.5 0 017 5v6a1.5 1.5 0 01-3 0V5a1.5 1.5 0 011.5-1.5zm5 0A1.5 1.5 0 0112 5v6a1.5 1.5 0 01-3 0V5a1.5 1.5 0 011.5-1.5z"/></svg>';
        const ICON_PLAY  = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M10.804 8L5 4.633v6.734L10.804 8zm.792-.696a.802.802 0 010 1.392l-6.363 3.692C4.713 12.69 4 12.345 4 11.692V4.308c0-.653.713-.998 1.233-.696l6.363 3.692z"/></svg>';

        el('feedPauseBtn') && el('feedPauseBtn').addEventListener('click', () => {
            state.feedPaused = !state.feedPaused;
            Feed.setPaused(state.feedPaused);
            const btn = el('feedPauseBtn');
            btn.classList.toggle('paused', state.feedPaused);
            btn.innerHTML = state.feedPaused ? ICON_PLAY : ICON_PAUSE;
            btn.title = state.feedPaused ? 'Resume live feed' : 'Pause live feed';
        });
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                state.topTab = btn.dataset.tab;
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
                refreshTopLists();
            });
        });

        initDomainSearch();
    }

    function initDomainSearch() {
        const form = document.getElementById('domainSearchForm');
        if (!form || form.dataset.ready === 'true') return;
        form.dataset.ready = 'true';
        form.addEventListener('submit', e => {
            e.preventDefault();
            searchDomainCache();
        });
        const clearBtn = document.getElementById('clearResultsBtn');
        if (clearBtn && !clearBtn.dataset.ready) {
            clearBtn.dataset.ready = 'true';
            clearBtn.addEventListener('click', e => {
                e.preventDefault();
                clearDomainSearchResults();
            });
        }
    }

    function clearDomainSearchResults() {
        const input = document.getElementById('domainSearchInput');
        const serverSel = document.getElementById('domainSearchServerSelect');
        const summary = document.getElementById('domainSearchSummary');
        const results = document.getElementById('domainSearchResults');
        const blockedSection = document.getElementById('blockedLookupResults');
        const checkbox = document.getElementById('blockedResultCheckbox');

        if (input) input.value = '';
        if (checkbox) { checkbox.checked = false; state.blockedLookup = false; }
        if (summary) { summary.className = 'domain-search-summary no-data'; summary.textContent = 'Enter a domain to inspect DNS cache.'; }
        if (results) results.innerHTML = '';
        if (blockedSection) blockedSection.innerHTML = '';
        // optionally reset server select to 'all'
        if (serverSel) serverSel.value = state.domainSearchServer || 'all';
    }

    async function searchDomainCache() {
        const input = document.getElementById('domainSearchInput');
        const serverSel = document.getElementById('domainSearchServerSelect');
        const blockedSection = document.getElementById('blockedLookupResults');
        const summary = document.getElementById('domainSearchSummary');
        const results = document.getElementById('domainSearchResults');
        const btn = document.querySelector('#domainSearchForm .search-btn');
        if (!input || !summary || !results) return;

        const domain = input.value.trim().replace(/^\.+|\.+$/g, '').toLowerCase();
        if (!domain) return;

        state.domainSearchServer = serverSel?.value || state.domainSearchServer || 'all';
        state.blockedLookup = document.getElementById('blockedResultCheckbox')?.checked || false;
        summary.className = 'domain-search-summary no-data';
        summary.textContent = 'Searching cache...';
        results.innerHTML = '';
        if (blockedSection) blockedSection.innerHTML = '';
        if (btn) btn.disabled = true;

        try {
            const url = '/api/cache/search?domain=' + encodeURIComponent(domain) + '&server=' + encodeURIComponent(state.domainSearchServer) + '&blocked=' + (state.blockedLookup ? '1' : '0');
            const res = await fetch(url, { cache: 'no-store' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Cache search failed');
            renderDomainCacheResults(data);
        } catch (e) {
            summary.className = 'domain-search-summary domain-search-error';
            summary.textContent = e.message || 'Cache search failed';
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function renderDomainCacheResults(data) {
        const summary = document.getElementById('domainSearchSummary');
        const results = document.getElementById('domainSearchResults');
        const blockedSection = document.getElementById('blockedLookupResults');
        if (!summary || !results) return;

        const selectedServers = data.results || [];
        const cachedServers = selectedServers.filter(r => r.cached).map(r => r.server);
        const serverCountText = data.searchedAllNodes
            ? cachedServers.length + ' of ' + selectedServers.length + ' servers'
            : (cachedServers.length ? '1 server' : '0 servers');

        const summaryClass = cachedServers.length ? 'domain-search-hit' : 'domain-search-miss';
        summary.className = 'domain-search-summary ' + summaryClass;
        summary.textContent = data.domain + ' is cached on ' + serverCountText + '.';

        if (blockedSection) {
            blockedSection.innerHTML = data.blockedLookup && data.blockedSummary
                ? renderBlockedLookupSummary(data.blockedSummary)
                : '';
        }

        results.innerHTML =
            '<div class="domain-search-result-details">' +
                '<div class="domain-search-target">' +
                    '<div>' +
                        '<div class="domain-search-title">' + esc(data.domain) + '</div>' +
                        '<div class="domain-search-meta">' + serverCountText + '</div>' +
                    '</div>' +
                    '<div class="domain-server-list">' +
                        cachedServers.map(server => '<span class="domain-server-pill">' + esc(server) + '</span>').join('') +
                    '</div>' +
                '</div>' +
                '<div class="domain-search-node-list">' +
                    selectedServers.map(renderDomainCacheNode).join('') +
                '</div>' +
            '</div>';
    }

    function renderDomainCacheNode(node) {
        const statusClass = !node.ok ? 'domain-node-error' : node.cached ? 'domain-node-hit' : 'domain-node-miss';
        const statusBadgeClass = !node.ok
            ? 'neutral'
            : node.blockedLookup
                ? node.cached ? 'danger' : 'success'
                : node.cached ? 'success' : 'danger';
        const statusText = !node.ok
            ? 'Error'
            : node.blockedLookup
                ? node.cached ? 'Blocked' : 'Not blocked'
                : node.cached ? 'Cached' : 'Not cached';
        const allRecords = collectCacheRecords(node);
        const records = allRecords.filter(r => !isDnssecRecordType(r.record));
        
        let body;
        if (!node.ok) {
            body = '<div class="domain-cache-empty">' + esc(node.error || 'Unable to search this node') + '</div>';
        } else if (records.length > 0) {
            body = '<div class="domain-cache-table-wrap"><table class="domain-cache-table"><thead><tr><th>Type</th><th>Answer</th><th>TTL</th><th>Status</th></tr></thead><tbody>' +
                    records.map(renderDomainCacheRecord).join('') +
                    '</tbody></table></div>';
        } else if (allRecords.length > 0) {
            body = '<div class="domain-cache-empty">Only DNSSEC records cached for this domain on this node.</div>';
        } else {
            body = '<div class="domain-cache-empty">Domain not cached on this node.</div>';
        }

        return '<article class="domain-cache-node ' + statusClass + '">' +
            '<div class="domain-cache-node-head">' +
            '<div class="domain-search-node-title"><span class="srv-card-name">' + esc(node.server) + '</span>' +
            (node.domain && node.domain !== node.server ? '<span class="node-domain">' + esc(node.domain) + '</span>' : '') +
            '</div>' +
            '<span class="status-badge ' + statusBadgeClass + '">' + statusText + '</span>' +
            '</div>' +
            body +
            '</article>';
    }

    function formatBlockedSource(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) return value;
        return normalized === 'block-list-zone' ? 'URL Blocklist'
            : normalized === 'blocked-zone' ? 'Local Blocked Zone'
            : normalized === 'advanced-blocking-app' ? 'Advanced Blocking App'
            : value;
    }

    function renderBlockedLookupSummary(node) {
        const parsedEntries = Array.isArray(node.blockedMeta?.entries) && node.blockedMeta.entries.length
            ? node.blockedMeta.entries
            : node.blockedMeta?.parsed ? [node.blockedMeta.parsed] : [];
        const labelMap = {
            source: 'Source',
            group: 'Group',
            blocklisturl: 'Block List',
            blocklist: 'Block List',
            'block list': 'Block List',
            domain: 'Domain',
            blockreason: 'Reason',
            reason: 'Reason',
        };

        const splitValues = value => {
            if (typeof value !== 'string') return [String(value)];
            const parts = value.split(/[,;]\s*/).map(v => v.trim()).filter(Boolean);
            return parts.length ? parts : [value];
        };

        const detailMap = new Map();
        parsedEntries.forEach(entry => {
            for (const [key, value] of Object.entries(entry || {})) {
                if (!value) continue;
                const normalized = key.toLowerCase();
                if (normalized === 'domain' || normalized === 'raw') continue;

                const label = labelMap[normalized] || normalized.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
                const displayValue = normalized === 'source' ? formatBlockedSource(value) : value;
                const values = splitValues(displayValue).map(v => esc(v));

                const group = detailMap.get(label) || { label, values: [] };
                values.forEach(v => {
                    if (!group.values.includes(v)) group.values.push(v);
                });
                detailMap.set(label, group);
            }
        });

        const details = [];
        detailMap.forEach(({ label, values }) => {
            if (!values.length) return;
            details.push({ label, value: values[0] });
            values.slice(1).forEach(value => details.push({ label: '', value }));
        });

        const hasBlockedMeta = node.blockedMeta && (
            (Array.isArray(node.blockedMeta.entries) && node.blockedMeta.entries.length > 0) ||
            (node.blockedMeta.parsed && Object.keys(node.blockedMeta.parsed).length > 0) ||
            node.blockedMeta.source || node.blockedMeta.group
        );
        const statusBadge = node.ok
            ? (node.blocked || hasBlockedMeta)
                ? '<span class="status-badge danger">Blocked</span>'
                : '<span class="status-badge success">Not blocked</span>'
            : '<span class="status-badge neutral">Lookup failed</span>';

        return '<article class="blocked-lookup-card">' +
            '<div class="blocked-lookup-card-header">' +
                '<div class="blocked-lookup-card-title">' + esc(node.server) + '</div>' +
                '<div>' + statusBadge + '</div>' +
            '</div>' +
            '<div class="blocked-lookup-card-meta">' +
                (details.length ? details.map(item => typeof item === 'string'
                    ? '<div>' + item + '</div>'
                    : '<div class="blocked-lookup-meta-row"><span class="blocked-lookup-meta-label">' + (item.label ? esc(item.label + ':') : '&nbsp;') + '</span><span class="blocked-lookup-meta-value">' + item.value + '</span></div>').join('')
                    : '<div>Blocked lookup response</div>') +
            '</div>' +
        '</article>';
    }

    function collectCacheRecords(node) {
        const out = [];
        for (const z of node.zones || []) {
            const zoneName = z.name || z.zone || z.domain || '';
            for (const r of z.records || []) out.push({ zoneName, record: r });
        }
        for (const r of node.records || []) out.push({ zoneName: '', record: r });
        return out;
    }

    function renderDomainCacheRecord(item) {
        const r = item.record || {};
        const type = r.type || r.recordType || r.dnsResourceRecordType || '';
        const answer = recordValue(r);
        const ttl = getRecordTTL(r);
        const status = getSecurityStatus(r);
        const lastUsed = getRecordLastUsed(r);

        return '<tr>' +
            '<td>' + esc(type) + '</td>' +
            '<td>' + esc(answer) + (lastUsed ? '<div class="record-meta">' + esc(lastUsed) + '</div>' : '') + '</td>' +
            '<td>' + esc(ttl) + '</td>' +
            '<td>' + esc(status) + '</td>' +
            '</tr>';
    }

    function recordValue(record) {
        const rData = record.rData;
        if (rData && typeof rData === 'object') {
            if (rData.value != null) return rData.value;
            const values = Object.values(rData).filter(v => v != null && typeof v !== 'object');
            if (values.length) return values.join(' ');
        }
        return record.value || record.data || record.text || record.address || record.exchange || JSON.stringify(record);
    }

    const DNSSEC_TYPES = new Set(['RRSIG', 'DNSKEY', 'DS', 'NSEC', 'NSEC3', 'NSEC3PARAM', 'CDNSKEY', 'CDS', 'DLV']);

    function isDnssecRecordType(record) {
        const type = String(record?.type || record?.recordType || record?.dnsResourceRecordType || '').toUpperCase();
        return DNSSEC_TYPES.has(type);
    }

    function getRecordTTL(record) {
        return record.ttl ?? record.originalTtl ?? record.expiryTtl ?? record.expiresIn ?? '';
    }

    function getSecurityStatus(record) {
        const raw = String(record.dnsSecStatus || record.dnssecStatus || record.validationStatus || record.securityStatus || record.security || record.secure || record.status || '').trim().toLowerCase();
        if (!raw) return 'Unknown';
        if (raw.includes('insecure') || raw.includes('bogus') || raw.includes('failed')) return 'Insecure';
        if (raw.includes('disabled') || raw.includes('not supported')) return 'Disabled';
        if (raw.includes('secure') || raw.includes('validated') || raw === 'ok') return 'Secure';
        return raw.charAt(0).toUpperCase() + raw.slice(1);
    }

    function getRecordLastUsed(record) {
        const last = record.lastUsedOn || record.lastUsedValue || record.lastUsed || record.lastAccessed || record.lastSeen || record.lastUsedAt || record.lastSeenAt || record.lastQuery;
        if (!last) return '';
        if (typeof last === 'number') return 'Last used: ' + last;
        const date = new Date(last);
        if (!isNaN(date)) return 'Last used: ' + relativeTime(date.toISOString());
        return 'Last used: ' + last;
    }

    function getDatasetMode() {
        const sel = document.getElementById('chartDatasetSelect');
        return sel ? sel.value : 'overview';
    }

    // ---- Render cards / cluster view ----------------------------------------
    function renderClusterCards() {
        const container = document.getElementById('clusterCards');
        if (!container) return;

        container.innerHTML = '';

        if (state.activeTab === CLUSTER_KEY) {
            renderClusterView(container);
        } else if (state.activeTab === 'all') {
            for (const name of state.serverNames) {
                container.appendChild(buildServerCard(name, state.nodes[name]));
            }
        } else {
            container.appendChild(buildServerCard(state.activeTab, state.nodes[state.activeTab]));
            container.appendChild(buildPerfCard(state.activeTab, state.perf[state.activeTab] || null));
        }
    }

    function renderClusterView(container) {
        const cluster = state.nodes[CLUSTER_KEY];
        if (!cluster) return;

        // Aggregate stat card (full width)
        container.appendChild(buildAggregateCard(cluster));

        // Per-node stat cards
        const nodeRoles = {};
        for (const cn of cluster.clusterNodes || []) {
            nodeRoles[cn.name] = cn.type; // "Primary" or "Secondary"
        }
        for (const name of state.serverNames) {
            const node = state.nodes[name];
            const domain = node?.dnsServerDomain || name;
            const role = nodeRoles[domain] || null;
            container.appendChild(buildServerCard(name, node, role));
        }

        // Cluster node table (full width)
        if (cluster.clusterNodes?.length) {
            container.appendChild(buildNodeTable(cluster.clusterNodes, cluster.clusterDomain));
        }
    }

    function buildAggregateCard(cluster) {
        const st = cluster.stats?.stats || {};
        const total   = st.totalQueries      || 0;
        const blocked = st.totalBlocked      || 0;
        const cached  = st.totalCached       || 0;
        const noerr   = st.totalNoError      || 0;
        const nx      = st.totalNxDomain     || 0;
        const fail    = st.totalServerFailure|| 0;
        const clients = st.totalClients      || 0;
        const recursive = st.totalRecursive  || 0;
        const auth    = st.totalAuthoritative|| 0;
        const refused = st.totalRefused      || 0;
        const dropped = st.totalDropped      || 0;
        const pct     = total > 0 ? Math.round(blocked / total * 100) : 0;

        const card = document.createElement('div');
        card.className = 'srv-card';
        card.innerHTML =
            '<div class="srv-card-header">' +
            '<span class="srv-card-name">Cluster</span>' +
            '<span class="srv-card-version">' + esc(cluster.clusterDomain || '') + '</span>' +
            '</div>' +
            '<div class="srv-card-role"><span class="node-badge primary">Cluster</span></div>' +
            '<div class="srv-stats-grid">' +
            statMini('Total',   fmtNum(total),   'blue') +
            statMini('No Error', fmtNum(noerr),   'green') +
            statMini('Failures', fmtNum(fail),    'red') +
            statMini('NXDOMAIN', fmtNum(nx),     'ora') +
            statMini('Refused',  fmtNum(refused), 'slate') +
            statMini('Authoritative', fmtNum(auth), 'yel') +
            statMini('Recursive', fmtNum(recursive), 'pur') +
            statMini('Cached',   fmtNum(cached),  'teal') +
            statMini('Blocked',  fmtNum(blocked), 'red') +
            statMini('Dropped',  fmtNum(dropped), 'slate') +
            statMini('Clients',  fmtNum(clients), 'pur') +
            '</div>' +
            '<div class="srv-card-footer">' +
            '<span class="blocked-pct">' + pct + '% blocked</span>' +
            '<div class="blocked-bar"><div class="blocked-bar-fill" style="width:' + Math.min(pct, 100) + '%"></div></div>' +
            '</div>';
        return card;
    }

    function buildNodeTable(nodes, clusterDomain) {
        const wrap = document.createElement('div');
        wrap.className = 'node-table-wrap card';

        let rows = nodes.map(n => {
            const stateClass = n.state === 'Self' || n.state === 'Connected' ? 'node-online' : 'node-offline';
            const typeBadge  = n.type === 'Primary' ? '<span class="node-badge primary">Primary</span>' : '<span class="node-badge secondary">Secondary</span>';
            const ip         = (n.ipAddresses || []).join(', ');
            const url        = n.url || 'http://' + (n.name || n.ipAddresses?.[0] || '') + ':5380';
            const upSince    = n.upSince    ? relativeTime(n.upSince)    : '';
            const lastSeen   = n.lastSeen   ? relativeTime(n.lastSeen)   : (n.state === 'Self' ? 'self' : '');
            const lastSynced = n.configLastSynced && !n.configLastSynced.startsWith('0001-') ? relativeTime(n.configLastSynced) : '';

            return '<tr class="node-row">' +
                '<td><span class="node-dot ' + stateClass + '"></span> <span class="node-name">' + esc(n.name) + '</span></td>' +
                '<td>' + typeBadge + '</td>' +
                '<td class="node-url"><a href="' + esc(url) + '" target="_blank">' + esc(url) + '</a></td>' +
                '<td class="node-ip">' + esc(ip) + '</td>' +
                '<td class="node-time">up ' + esc(upSince) + '</td>' +
                '<td class="node-time">' + esc(lastSeen) + '</td>' +
                '<td class="node-time">' + (lastSynced ? 'synced ' + esc(lastSynced) : '') + '</td>' +
                '<td><span class="node-state ' + stateClass + '">' + esc(n.state) + '</span></td>' +
                '</tr>';
        }).join('');

        wrap.innerHTML =
            '<div class="card-header"><h2 class="card-title">Cluster Nodes' +
            (clusterDomain ? ' <span class="node-domain">' + esc(clusterDomain) + '</span>' : '') + '</h2></div>' +
            '<div class="node-table-scroll"><table class="node-table">' +
            '<thead><tr><th>Node</th><th>Role</th><th>URL</th><th>IP</th><th>Uptime</th><th>Last Seen</th><th>Last Synced</th><th>State</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
            '</table></div>';
        return wrap;
    }

    function buildServerCard(name, node, role) {
        const card = document.createElement('div');
        card.className = 'srv-card' + (node?.error ? ' offline' : '');

        if (!node || node.error) {
            card.innerHTML =
                '<div class="srv-card-header">' +
                '<span class="srv-card-name">' + esc(name) + '</span>' +
                '<span class="srv-card-version" style="color:var(--accent-red)">offline</span>' +
                '</div>';
            return card;
        }

        const st = node.stats?.stats || {};
        const total   = st.totalQueries      || 0;
        const blocked = st.totalBlocked      || 0;
        const cached  = st.totalCached       || 0;
        const noerr   = st.totalNoError      || 0;
        const nx      = st.totalNxDomain     || 0;
        const fail    = st.totalServerFailure|| 0;
        const clients = st.totalClients      || 0;
        const recursive = st.totalRecursive  || 0;
        const auth    = st.totalAuthoritative|| 0;
        const refused = st.totalRefused      || 0;
        const dropped = st.totalDropped      || 0;
        const pct     = total > 0 ? Math.round(blocked / total * 100) : 0;

        if (!role && node.clusterInitialized === false) role = 'Standalone';
        const badgeClass = role === 'Primary' ? 'primary' : role === 'Secondary' ? 'secondary' : 'standalone';
        const roleBadge = role
            ? '<span class="node-badge ' + badgeClass + '">' + esc(role) + '</span>'
            : '';

        card.innerHTML =
            '<div class="srv-card-header">' +
            '<span class="srv-card-name">' + esc(node.dnsServerDomain || name) + '</span>' +
            '<span class="srv-card-version">v' + esc(node.version) + '</span>' +
            '</div>' +
            (roleBadge ? '<div class="srv-card-role">' + roleBadge + '</div>' : '') +
            '<div class="srv-stats-grid">' +
            statMini('Total',   fmtNum(total), 'blue') +
            statMini('No Error', fmtNum(noerr), 'green') +
            statMini('Failures', fmtNum(fail), 'ora') +
            statMini('NXDOMAIN', fmtNum(nx), 'yel') +
            statMini('Refused',  fmtNum(refused), 'slate') +
            statMini('Authoritative', fmtNum(auth), 'blue') +
            statMini('Recursive', fmtNum(recursive), 'pur') +
            statMini('Cached',   fmtNum(cached),  'teal') +
            statMini('Blocked',  fmtNum(blocked), 'red') +
            statMini('Dropped',  fmtNum(dropped), 'slate') +
            statMini('Clients',  fmtNum(clients), 'pur') +
            '</div>' +
            '<div class="srv-card-footer">' +
            '<span class="blocked-pct">' + pct + '% blocked</span>' +
            '<div class="blocked-bar"><div class="blocked-bar-fill" style="width:' + Math.min(pct, 100) + '%"></div></div>' +
            '</div>';
        return card;
    }

    function statMini(label, value, colorClass) {
        return '<div class="stat-mini"><span class="stat-mini-label">' + esc(label) +
               '</span><span class="stat-mini-value ' + colorClass + '">' + esc(value) + '</span></div>';
    }

    // ---- Server indicators --------------------------------------------------
    function renderServerIndicators() {
        const el = document.getElementById('serverIndicators');
        if (!el) return;
        el.innerHTML = state.serverNames.map(name => {
            const node = state.nodes[name];
            const ok = node && !node.error;
            return '<span class="server-pill ' + (ok ? 'online' : 'offline') + '">' +
                   '<span class="pill-dot"></span>' + esc(name) + '</span>';
        }).join('');
    }

    // ---- Performance cards --------------------------------------------------
    function renderPerfCards() {
        const container = document.getElementById('perfCards');
        if (!container) return;

        // Single server: perf card is rendered inline next to the stats card
        if (state.activeTab !== CLUSTER_KEY && state.activeTab !== 'all') {
            container.innerHTML = '';
            return;
        }

        const names = state.serverNames;
        if (names.length === 0) return;

        container.innerHTML = '';
        for (const name of names) {
            container.appendChild(buildPerfCard(name, state.perf[name] || null));
        }
    }

    function buildPerfCard(name, perf) {
        const card = document.createElement('div');
        card.className = 'srv-card perf-card';

        if (!perf) {
            card.innerHTML =
                '<div class="srv-card-header">' +
                '<span class="srv-card-name">' + esc(name) + '</span>' +
                '<span class="srv-card-version perf-samples">collecting samples...</span>' +
                '</div>' +
                '<div class="srv-card-role"><span class="perf-section-label">RTT</span></div>' +
                '<div class="srv-stats-grid">' +
                statMini('Median', '--', 'teal') +
                statMini('Mean',   '--', 'blue') +
                statMini('P99',    '--', 'yel') +
                statMini('Jitter', '--', 'ora') +
                '</div>' +
                '<div class="srv-card-role" style="margin-top:6px"><span class="perf-section-label">Cache</span></div>' +
                '<div class="srv-stats-grid">' +
                statMini('Hit Rate',  '--', 'green') +
                statMini('Miss Rate', '--', 'red') +
                statMini('Entries',   '--', 'teal') +
                statMini('Impact',    '--', 'pur') +
                '</div>';
            return card;
        }

        const rtt   = perf.rtt   || {};
        const cache = perf.cache || {};

        const cachePopHtml  = cache.maxEntries > 0
            ? Math.round(cache.entries / cache.maxEntries * 100) + '%'
            : fmtNum(cache.entries);
        const cachePopLabel = cache.maxEntries > 0 ? 'Cache Pop.' : 'Entries';
        const missRate = 100 - (cache.hitRate || 0);

        card.innerHTML =
            '<div class="srv-card-header">' +
            '<span class="srv-card-name">' + esc(name) + '</span>' +
            '<span class="srv-card-version perf-samples">' + (rtt.samples || 0) + ' recursive sample' + ((rtt.samples === 1) ? '' : 's') + '</span>' +
            '</div>' +
            '<div class="srv-card-role"><span class="perf-section-label">RTT</span></div>' +
            '<div class="srv-stats-grid">' +
            statMini('Median',  fmtMs(rtt.median), 'teal') +
            statMini('Mean',    fmtMs(rtt.mean),   'blue') +
            statMini('P99',     fmtMs(rtt.p99),    'yel') +
            statMini('Jitter',  fmtMs(rtt.jitter), 'ora') +
            '</div>' +
            '<div class="srv-card-role" style="margin-top:6px"><span class="perf-section-label">Cache</span></div>' +
            '<div class="srv-stats-grid">' +
            statMini('Hit Rate',    cache.hitRate + '%',                              'green') +
            statMini('Miss Rate',   + missRate.toFixed(1) + '%',                      'red') +
            statMini(cachePopLabel, cachePopHtml,                                     'teal') +
            statMini('Impact',      fmtMs(perf.impact),                               'pur') +
            '</div>';

        return card;
    }

    // ---- Top lists ----------------------------------------------------------
    function renderTopLists() {
        const top = state.top[state.topServer];
        let items = [], colorClass = 'blue';
        if (top) {
            if (state.topTab === 'domains') { items = top.domains || []; colorClass = 'blue'; }
            else if (state.topTab === 'blocked') { items = top.blocked || []; colorClass = 'red'; }
            else if (state.topTab === 'clients') { items = top.clients || []; colorClass = 'pur'; }
        }
        renderTopListItems(items, colorClass);
    }

    function renderTopListItems(items, colorClass) {
        const container = document.getElementById('topContent');
        if (!container) return;

        if (!items.length) {
            container.innerHTML = '<div class="no-data">No data yet</div>';
            return;
        }

        const max = items[0]?.hits || 1;
        container.innerHTML = items.map((item, i) => {
            const pct = Math.round((item.hits / max) * 100);
            const sub = item.domain ? '<span class="top-sub" title="' + esc(item.domain) + '">' + esc(item.domain) + '</span>' : '';
            return '<div class="top-row">' +
                '<span class="top-rank">' + (i + 1) + '</span>' +
                '<span class="top-name" title="' + esc(item.name) + '">' + esc(item.name) + '</span>' +
                sub +
                '<div class="top-bar-wrap"><div class="top-bar"><div class="top-bar-fill ' + colorClass + '" style="width:' + pct + '%"></div></div></div>' +
                '<span class="top-hits">' + fmtNum(item.hits) + '</span>' +
                '</div>';
        }).join('');
    }

    // ---- Range-aware chart / top refresh ------------------------------------
    function updateChartHeading() {
        const headingMap = {
            'LastHour':  'Queries per minute',
            'LastDay':   'Queries per hour',
            'LastWeek':  'Queries per day',
            'LastMonth': 'Queries per day',
            'LastYear':  'Queries per day'
        };
        const heading = document.querySelector('.chart-section .card-title');
        if (heading) {
            heading.textContent = headingMap[state.timeRange] || 'Queries per minute';
        }
    }

    function refreshChart() {
        if (state.timeRange === 'LastHour') {
            Charts.update(state.nodes, state.chartServer, getDatasetMode());
            return;
        }
        const cacheKey = state.chartServer + ':' + state.timeRange;
        if (state.rangeCache[cacheKey]) {
            Charts.updateFromData(state.rangeCache[cacheKey], getDatasetMode());
            return;
        }
        fetch('/api/dashboard?server=' + encodeURIComponent(state.chartServer) + '&type=' + state.timeRange)
            .then(r => r.json())
            .then(data => {
                state.rangeCache[cacheKey] = data;
                Charts.updateFromData(data, getDatasetMode());
            })
            .catch(() => {});
    }

    function refreshTopLists(init) {
        if (state.timeRange === 'LastHour' && !init) {
            renderTopLists();
            return;
        }
        const statsTypeMap = { domains: 'TopDomains', blocked: 'TopBlockedDomains', clients: 'TopClients' };
        const statsType = statsTypeMap[state.topTab] || 'TopDomains';
        const cacheKey = state.topServer + ':' + state.timeRange + ':' + statsType;
        if (state.rangeCache[cacheKey]) {
            renderTopListsFromData(state.rangeCache[cacheKey], statsType);
            return;
        }
        fetch('/api/top?server=' + encodeURIComponent(state.topServer) + '&type=' + state.timeRange + '&statsType=' + statsType)
            .then(r => r.json())
            .then(data => {
                state.rangeCache[cacheKey] = data;
                renderTopListsFromData(data, statsType);
            })
            .catch(() => {});
    }

    // Allow periodic (60s) refresh of LastDay data for both query chart and top lists, regardless of polling interval
    let lastDayTimer = null;

    function startLastDayRefresh() {
        stopLastDayRefresh();
        lastDayTimer = setInterval(() => {
            Object.keys(state.rangeCache).forEach(key => {
                if (key.includes(':LastDay')) delete state.rangeCache[key];
            });
            refreshChart();
            refreshTopLists();
        }, 60000);
    }

    function stopLastDayRefresh() {
        if (lastDayTimer) {
            clearInterval(lastDayTimer);
            lastDayTimer = null;
        }
    }

    function renderTopListsFromData(data, statsType) {
        const keyMap = { TopDomains: 'topDomains', TopBlockedDomains: 'topBlockedDomains', TopClients: 'topClients' };
        const colorMap = { TopDomains: 'blue', TopBlockedDomains: 'red', TopClients: 'pur' };
        const items = data[keyMap[statsType]] || [];
        const colorClass = colorMap[statsType] || 'blue';
        renderTopListItems(items, colorClass);
    }

    // ---- Helpers ------------------------------------------------------------
    function relativeTime(isoStr) {
        const ms = Date.now() - new Date(isoStr).getTime();
        const s = Math.floor(ms / 1000);
        if (s < 60)   return s + 's';
        const m = Math.floor(s / 60);
        if (m < 60)   return m + 'm';
        const h = Math.floor(m / 60);
        if (h < 24)   return h + 'h ' + (m % 60) + 'm';
        return Math.floor(h / 24) + 'd';
    }

    function setFeedStall(stalled) {
        const el = document.getElementById('feedStallBanner');
        if (!el) return;
        el.hidden = !stalled;
        if (stalled && state.lastFeedEvent) {
            const secs = Math.round((Date.now() - state.lastFeedEvent) / 1000);
            const age  = secs >= 60 ? Math.floor(secs / 60) + 'm' : secs + 's';
            el.textContent = 'Feed paused: no data received for ' + age + '. Check tdns-stats console for errors.';
        }
    }

    function setConnDot(cls) {
        const dot = document.getElementById('connIndicator')?.querySelector('.conn-dot');
        if (dot) dot.className = 'conn-dot ' + cls;
    }

    function updateLastUpdated() {
        const el = document.getElementById('lastUpdated');
        if (el && state.lastUpdated) {
            el.textContent = 'Updated ' + state.lastUpdated.toLocaleTimeString('en-GB', { hour12: false });
        }
    }

    function fmtNum(n) {
        if (n >= 1000000) return parseFloat((n / 1000000).toFixed(1)) + 'M';
        if (n >= 1000)    return parseFloat((n / 1000).toFixed(1)) + 'K';
        return String(n);
    }

    function fmtMs(n) {
        if (n == null) return '--';
        if (n >= 1000) return parseFloat((n / 1000).toFixed(2)) + 's';
        return parseFloat(n.toFixed(1)) + 'ms';
    }

    function esc(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function applyTheme(theme) {
        const root = document.documentElement;
        if (theme === 'dark') {
            root.setAttribute('data-theme', 'dark');
        } else if (theme === 'light') {
            root.setAttribute('data-theme', 'light');
        } else {
            root.removeAttribute('data-theme');
        }
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
    }

    function initTheme() {
        const saved = localStorage.getItem('tdns-theme') || 'system';
        applyTheme(saved);
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const t = btn.dataset.theme;
                applyTheme(t);
                localStorage.setItem('tdns-theme', t);
            });
        });
    }

    // ---- Main page tabs (Dashboard / Cache & Blocked) ----------------------
    function initMainTabs() {
        const btns = document.querySelectorAll('.main-tab-btn');
        const dashView      = document.getElementById('dashboardView');
        const cacheBlockedView = document.getElementById('cacheBlockedView');

        function setMainTab(tab) {
            const isDash = tab === 'dashboard';
            dashView.hidden        = !isDash;
            cacheBlockedView.hidden = isDash;
            btns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
            localStorage.setItem('tdns-main-tab', tab);
        }

        btns.forEach(btn => {
            btn.addEventListener('click', () => setMainTab(btn.dataset.tab));
        });

        // Restore last active tab
        const saved = localStorage.getItem('tdns-main-tab') || 'dashboard';
        setMainTab(saved);
    }

    // ---- Chart persistence ---------------------------------------------------
    function getChartStorageKey(viewMode) {
        return 'tdns-chart-hidden-' + viewMode;
    }

    function loadHiddenChartState(viewMode) {
        const stored = localStorage.getItem(getChartStorageKey(viewMode));
        return stored ? new Set(JSON.parse(stored)) : new Set();
    }

    function saveHiddenChartState(viewMode, hiddenSet) {
        localStorage.setItem(
            getChartStorageKey(viewMode),
            JSON.stringify(Array.from(hiddenSet))
        );
    }

    function getFeedFilterStorageKey(server) {
        return 'tdns-feed-filters-' + (server || 'all');
    }

    function loadFeedFilters(server) {
        const stored = localStorage.getItem(getFeedFilterStorageKey(server));
        return stored ? new Set(JSON.parse(stored)) : new Set();
    }

    function saveFeedFilters(server, filterSet) {
        localStorage.setItem(getFeedFilterStorageKey(server), JSON.stringify(Array.from(filterSet)));
    }

    // ---- Update functionality ---------------------------------------------------
    function handleUpdateStatus(data) {
        state.updateStatus = data.status;
        updateStatusDisplay();

        if (data.status === 'done') {
            setTimeout(() => {
                state.updateStatus = null;
                document.getElementById('updateStatus').hidden = true;
                document.getElementById('updateBtn').hidden = true;
                state.updateAvailable = false;
            }, 3000);
        }
    }

    function updateStatusDisplay() {
        const statusEl = document.getElementById('updateStatus');
        const checkBtn = document.getElementById('checkUpdatesBtn');
        const updateBtn = document.getElementById('updateBtn');
        const overlay = document.getElementById('updateOverlay');
        const overlayText = document.getElementById('updateOverlayText');

        if (!state.updateStatus) {
            statusEl.hidden = true;
            updateBtn.hidden = true;
            overlay.hidden = true;
            checkBtn.classList.remove('checking', 'updating');
            updateBtn.classList.remove('updating', 'update-ready');
            return;
        }

        statusEl.hidden = false;
        const messages = {
            'checking': 'Checking...',
            'checked': 'Up to date',
            'update-available': 'Update available',
            'updating': 'Updating...',
            'restarting': 'Service is restarting...',
            'reconnecting': 'Reconnecting...',
            'done': 'Update complete!'
        };
        statusEl.textContent = messages[state.updateStatus] || state.updateStatus;
        statusEl.className = 'update-status';

        if (state.updateStatus === 'checking') {
            checkBtn.classList.add('checking');
            statusEl.classList.remove('success', 'error');
            overlay.hidden = true;
        } else if (state.updateStatus === 'checked') {
            checkBtn.classList.remove('checking');
            statusEl.classList.add('success');
            overlay.hidden = true;
        } else if (state.updateStatus === 'update-available') {
            statusEl.classList.remove('success', 'error');
            updateBtn.classList.add('update-ready');
            updateBtn.hidden = false;
            overlay.hidden = true;
        } else if (state.updateStatus === 'updating' || state.updateStatus === 'restarting' || state.updateStatus === 'reconnecting') {
            updateBtn.classList.add('updating');
            checkBtn.classList.add('checking');
            overlay.hidden = false;
            overlayText.textContent = messages[state.updateStatus];
        } else if (state.updateStatus === 'done') {
            statusEl.classList.add('success');
            checkBtn.classList.remove('checking');
            updateBtn.classList.remove('updating', 'update-ready');
            overlayText.textContent = messages[state.updateStatus];
            setTimeout(() => {
                overlay.hidden = true;
                state.updateStatus = null;
            }, 1500);
        }
    }

    async function fetchVersion() {
        try {
            const res = await fetch('/api/version');
            const data = await res.json();
            if (data.version) {
                state.version = data.version;
                document.getElementById('versionPill').textContent = 'v' + data.version;
            }
        } catch (e) {
            console.error('Failed to fetch version:', e);
        }
    }

    async function checkUpdates() {
        if (state.updateStatus === 'checking') return;

        state.updateStatus = 'checking';
        updateStatusDisplay();

        try {
            const res = await fetch('/api/updates/check');
            const data = await res.json();

            if (data.error) {
                state.updateStatus = null;
                updateStatusDisplay();
                return;
            }

            if (data.updateAvailable) {
                state.updateAvailable = true;
                state.updateStatus = 'update-available';
            } else {
                state.updateStatus = 'checked';
                setTimeout(() => {
                    state.updateStatus = null;
                    updateStatusDisplay();
                }, 2000);
            }
            updateStatusDisplay();
        } catch (e) {
            console.error('Failed to check updates:', e);
            state.updateStatus = null;
            updateStatusDisplay();
        }
    }

    async function triggerUpdate() {
        if (state.updateStatus === 'updating') return;

        state.updateStatus = 'updating';
        updateStatusDisplay();

        try {
            const res = await fetch('/api/updates/trigger', { method: 'POST' });
            if (!res.ok) {
                state.updateStatus = null;
                updateStatusDisplay();
                return;
            }

            state.updateStatus = 'restarting';
            updateStatusDisplay();

            // Poll for service recovery
            await pollHealth();
        } catch (e) {
            console.error('Failed to trigger update:', e);
            state.updateStatus = null;
            updateStatusDisplay();
        }
    }

    async function pollHealth() {
        const maxAttempts = 90; // 90 * 2 seconds = 3 minutes max
        let attempts = 0;
        let initialStartedAt = null;

        state.updateStatus = 'reconnecting';
        updateStatusDisplay();

        // Capture initial started_at before polling
        try {
            const res = await fetch('/api/health', { cache: 'no-store' });
            if (res.ok) {
                const data = await res.json();
                initialStartedAt = data.started_at;
            }
        } catch (e) {
            // Ignore - will get it on first poll attempt
        }

        const poll = async () => {
            attempts++;
            try {
                const res = await fetch('/api/health', { cache: 'no-store' });
                if (res.ok) {
                    const data = await res.json();
                    // Service only considered "back" if started_at has changed
                    if (initialStartedAt && data.started_at && data.started_at > initialStartedAt) {
                        state.updateStatus = 'done';
                        updateStatusDisplay();
                        // Clear caches and reload
                        try {
                            if ('caches' in window) {
                                const keys = await caches.keys();
                                await Promise.all(keys.map(k => caches.delete(k)));
                            }
                        } catch (e) {}

                        // Clear any pending reconnection timer before reload
                        if (reconnectTimer) {
                            clearInterval(reconnectTimer);
                            reconnectTimer = null;
                        }

                        setTimeout(() => location.reload(), 1500);
                        return;
                    }
                }
            } catch (e) {
                // Service not ready yet
            }

            if (attempts < maxAttempts) {
                setTimeout(poll, 2000);
            } else {
                state.updateStatus = null;
                updateStatusDisplay();
            }
        };

        poll();
    }

    function setupUpdateButtons() {
        document.getElementById('checkUpdatesBtn').addEventListener('click', checkUpdates);
        document.getElementById('updateBtn').addEventListener('click', triggerUpdate);
    }

    function init() {
        const tr = document.getElementById('timeRangeSelect');
        if (tr) state.timeRange = tr.value;
        if (state.timeRange === 'LastDay') startLastDayRefresh();
        initTheme();
        initMainTabs();
        setupUpdateButtons();
        fetchVersion();
        updateChartHeading();
        Charts.init();
        Charts.setPersistCallback(saveHiddenChartState);
        Charts.setLoadCallback(loadHiddenChartState);
        fetch('/api/config')
            .then(r => r.json())
            .then(cfg => {
                if (cfg.serverColors && typeof cfg.serverColors === 'object') state.serverColorMap = cfg.serverColors;
                Feed.init(cfg.maxEntries);
            })
            .catch(() => {})
            .finally(() => connect());

        // Show a warning banner if the feed has gone silent while SSE is connected
        setInterval(() => {
            if (!state.connected || state.lastFeedEvent === null) return;
            setFeedStall(Date.now() - state.lastFeedEvent > 120000);
        }, 15000);
    }

    return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
