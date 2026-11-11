'use strict';

/**
 * The live feed.
 *
 * Holds the query log entries as they arrive, keeps them in order and free of
 * duplicates, and draws the rows the feed shows.
 */

import { Log } from './log.js';
import { escapeHtml, normalizeDomain, normalizeClient } from './helpers.js';
import { Selection } from './selection.js';

const Feed = (() => {
    let MAX_ENTRIES = 200;
    const entries = [];
    const seenByServer = {};

    let renderTimer = null;
    let lastFilter = 'all';
    let lastBlocked = false;
    let colorMap = {};
    let paused = false;
    let serverDisplayMap = {};
    let serverStatus = {}; // serverName -> { queryLogsApp: string|null, queryLogsAppName: string|null }
    // Created on first use so this module can be imported outside a browser.
    let textCtx = null;
    function getTextCtx() {
        if (!textCtx) {
            textCtx = document.createElement('canvas').getContext('2d');
            textCtx.font = '600 11px "Chakra Petch", system-ui, sans-serif';
        }
        return textCtx;
    }

    // ---- Feed setup ------------------------------------------------------------------
    function init(maxEntries) {
        if (maxEntries > 0) MAX_ENTRIES = maxEntries;
    }

    /**
     * The feed owns its list, so it answers the clicks on the names and the
     * client addresses itself.
     */
    function bindFeedClicks(list) {
        if (list.dataset.ready === 'true') return;
        list.dataset.ready = 'true';
        list.addEventListener('click', e => {
            if (Selection.isClickSuppressed()) return;
            const cell = e.target.closest('.feed-domain, .feed-client');
            if (!cell || !cell.dataset.filterKind) return;

            // A drag that ends on a cell should select text, not change filters.
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed && (cell.contains(selection.anchorNode) || cell.contains(selection.focusNode))) return;

            Selection.applyValue(cell.dataset.filterKind, cell.dataset.filterValue, {
                toggle: e.ctrlKey || e.metaKey,
            });
        });
    }

    function setServerDisplayMap(map) {
        serverDisplayMap = map;
    }

    /**
     * Lets the "no data" message distinguish a genuinely quiet feed from a
     * configured query log app that the backend could not find on the server.
     */
    function setServerStatus(status) {
        serverStatus = status || {};
        render(lastFilter, lastBlocked);
    }

    function noDataMessage(serverFilter, hasSelection) {
        const relevant = serverFilter === 'all' ? Object.values(serverStatus) : [serverStatus[serverFilter]];
        const unresolved = relevant.filter(st => st && st.queryLogsAppName && !st.queryLogsApp);
        // A genuinely missing app is the actionable problem, so it wins over a
        // lookup that has not succeeded yet (e.g. DNS not up after a boot).
        const missing = unresolved.find(st => !st.queryLogsLookupFailed);
        if (missing) {
            const scope = serverFilter === 'all' ? ' on one or more servers' : '';
            return '<div class="no-data warn">Query log app "' + escapeHtml(missing.queryLogsAppName) + '" not found' + scope + '</div>';
        }
        if (unresolved.length) {
            const scope = serverFilter === 'all' ? ' on one or more servers' : '';
            return '<div class="no-data">Could not reach the query log app' + scope + ', retrying...</div>';
        }
        if (hasSelection) return '<div class="no-data selection-empty">No feed entries match the selected filters</div>';
        return '<div class="no-data">Waiting for query data...</div>';
    }

    function setColors(map) {
        colorMap = map;
        const list = document.getElementById('feedList');
        if (list) list.innerHTML = '';
        render(lastFilter, lastBlocked);
    }

    // ---- Feed rows -------------------------------------------------------------------
    function add(serverName, newEntries, cursorReset) {
        if (cursorReset) {
            Log.debug(`[feed] ${serverName}: feed cursor reset`);
            // The log rotated, so wipe this server's seen IDs and drop its entries wholesale.
            seenByServer[serverName] = new Set();
            let writeIdx = 0;
            for (let i = 0; i < entries.length; i++) {
                if (entries[i]._server !== serverName) entries[writeIdx++] = entries[i];
            }
            entries.length = writeIdx;
        }

        const seen = seenByServer[serverName] || (seenByServer[serverName] = new Set());

        const deduped = [];
        for (const e of newEntries) {
            // A rowNumber is a position in the query log, not a stable ID: Technitium
            // renumbers every row when it prunes old entries. Include the timestamp so
            // a renumbered row is not mistaken for an already-seen one.
            const id = serverName + ':' + e.timestamp + '|' + e.rowNumber;
            if (seen.has(id)) continue;
            seen.add(id);
            deduped.push({ ...e, _server: serverName, _time: new Date(e.timestamp).getTime() });
        }
        if (deduped.length === 0) return;

        // Merge new entries into the sorted array in O(n + m) instead of O(n × m).
        // Both `entries` and `deduped` are sorted by _time descending. Sort deduped
        // explicitly since we should not assume API ordering across edge cases.
        deduped.sort((a, b) => b._time - a._time || b.rowNumber - a.rowNumber);

        const merged = [];
        let i = 0,
            j = 0;
        while (i < entries.length && j < deduped.length) {
            const e = entries[i];
            const d = deduped[j];
            if (d._time > e._time || (d._time === e._time && d._server === e._server && d.rowNumber > e.rowNumber)) {
                merged.push(d);
                j++;
            } else {
                merged.push(e);
                i++;
            }
        }
        while (i < entries.length) merged.push(entries[i++]);
        while (j < deduped.length) merged.push(deduped[j++]);

        // Replace the entries and evict the ones beyond MAX_ENTRIES.
        const limit = Math.min(merged.length, MAX_ENTRIES);
        entries.length = 0;
        for (let k = 0; k < limit; k++) entries.push(merged[k]);
        for (let k = limit; k < merged.length; k++) {
            const s = merged[k]._server;
            const sSet = seenByServer[s];
            if (sSet) sSet.delete(s + ':' + merged[k].timestamp + '|' + merged[k].rowNumber);
        }
    }

    // Debounce: batch rapid feed updates from multiple servers into one render.
    function setPaused(p) {
        paused = p;
        if (!paused) render(lastFilter, lastBlocked);
    }

    function hasSelection() {
        const filters = Selection.getFilters();
        return filters.domains.size > 0 || filters.blocked.size > 0 || filters.clients.size > 0;
    }

    function matchesSelection(e) {
        if (!hasSelection()) return true;

        const filters = Selection.getFilters();
        const qname = normalizeDomain(e.qname);
        const domainSelected = filters.domains.has(qname) || filters.blocked.has(qname);
        if ((filters.domains.size || filters.blocked.size) && !domainSelected) return false;

        if (filters.clients.size && !filters.clients.has(normalizeClient(e.clientIpAddress))) return false;
        return true;
    }

    // ---- Filters ---------------------------------------------------------------------
    function scheduleRender(serverFilter, filters) {
        lastFilter = serverFilter;
        lastBlocked = filters;
        if (paused || renderTimer) return;
        renderTimer = setTimeout(() => {
            renderTimer = null;
            render(lastFilter, lastBlocked);
        }, 250);
    }

    function filterEntries(serverFilter, filters) {
        return entries.filter(e => {
            if (serverFilter !== 'all' && e._server !== serverFilter) return false;
            if (filters.size > 0) {
                // Determine what this entry "is" based on our priority logic.
                let entryType = e.responseType;
                const rcode = (e.rcode || '').toLowerCase().replace(/\s+/g, '');

                if (entryType !== 'Blocked') {
                    if (rcode === 'nxdomain') entryType = 'NxDomain';
                    else if (rcode === 'serverfailure') entryType = 'ServerFailure';
                    else if (rcode === 'refused') entryType = 'Refused';
                }

                if (!filters.has(entryType)) return false;
            }
            if (!matchesSelection(e)) return false;
            return true;
        });
    }

    // ---- Rendering -------------------------------------------------------------------
    function render(serverFilter, filters) {
        lastFilter = serverFilter;
        lastBlocked = filters;

        const list = document.getElementById('feedList');
        if (!list) return;

        bindFeedClicks(list);

        const filtered = filterEntries(serverFilter, filters);

        if (filtered.length === 0) {
            list.innerHTML = noDataMessage(serverFilter, hasSelection());
            return;
        }

        const frag = document.createDocumentFragment();
        const max = Math.min(filtered.length, MAX_ENTRIES);
        let maxSrvW = 0;
        for (let i = 0; i < max; i++) {
            const e = filtered[i];
            const srvName = serverDisplayMap[e._server] || e._server;
            const w = Math.ceil(getTextCtx().measureText(srvName).width + srvName.length * 0.2) + 8;
            if (w > maxSrvW) maxSrvW = w;

            let badgeText = e.responseType || 'Unknown';
            const rcode = (e.rcode || '').toLowerCase().replace(/\s+/g, '');
            if (e.responseType !== 'Blocked') {
                if (rcode === 'nxdomain') badgeText = 'NX Domain';
                else if (rcode === 'serverfailure') badgeText = 'ServFail';
                else if (rcode === 'refused') badgeText = 'Refused';
            }

            const row = document.createElement('div');
            row.className = 'feed-row ' + rowClass(e);

            const ts = formatTime(e.timestamp);
            const serverClass = colorMap[e._server] ? ' ' + colorMap[e._server] : '';
            const badgeClass = badgeText.toLowerCase().replace(/\s+/g, '');

            const rttVal = e.responseRtt;
            const rtt = formatMs(rttVal, e.responseType);
            const latencyClass = getLatencyClass(rttVal);

            const clientValue = normalizeClient(e.clientIpAddress);
            const domainValue = normalizeDomain(e.qname);
            const domainKind = e.responseType === 'Blocked' ? 'blocked' : 'domains';
            const filters = Selection.getFilters();
            const domainSelected = filters.domains.has(domainValue) || filters.blocked.has(domainValue);
            const clientSelected = filters.clients.has(clientValue);

            row.innerHTML =
                '<span class="feed-time">' +
                escapeHtml(ts) +
                '</span>' +
                '<span class="feed-server' +
                serverClass +
                '" title="' +
                escapeHtml(e._server) +
                '">' +
                escapeHtml(srvName) +
                '</span>' +
                '<span class="feed-client" data-filter-kind="clients" data-filter-value="' +
                escapeHtml(clientValue) +
                '" title="' +
                escapeHtml(e.clientIpAddress + ' - ' + (clientSelected ? 'Click to remove filter' : 'Click to filter')) +
                '">' +
                escapeHtml(e.clientIpAddress) +
                '</span>' +
                '<span class="feed-proto">' +
                escapeHtml(e.protocol || '') +
                '</span>' +
                '<span class="feed-qtype">' +
                escapeHtml(e.qtype || '') +
                '</span>' +
                '<span class="feed-domain" data-filter-kind="' +
                domainKind +
                '" data-filter-value="' +
                escapeHtml(domainValue) +
                '" title="' +
                escapeHtml(e.qname + ' - ' + (domainSelected ? 'Click to remove filter' : 'Click to filter')) +
                '">' +
                escapeHtml(e.qname) +
                '</span>' +
                '<span class="feed-latency-type"><span class="feed-latency ' +
                latencyClass +
                '">' +
                escapeHtml(rtt) +
                '</span>' +
                '<span class="feed-type ' +
                badgeClass +
                '">' +
                escapeHtml(badgeText) +
                '</span></span>';

            frag.appendChild(row);
        }
        maxSrvW = Math.min(maxSrvW, 60);

        list.style.setProperty('--server-w', maxSrvW + 'px');
        list.replaceChildren(frag);
    }

    function getLatencyClass(n) {
        if (n == null || n <= 0) return '';
        if (n <= 20) return 'latency-low';
        if (n <= 100) return 'latency-mid';
        return 'latency-high';
    }

    function formatMs(n, type) {
        // If it is not a recursive query, it is effectively 0ms latency from the server's perspective.
        const instantTypes = ['Cached', 'Blocked', 'Authoritative', 'Refused', 'Dropped'];
        if (instantTypes.includes(type)) {
            return '';
        }

        if (n == null || n === undefined || !Number.isFinite(n)) return '';
        if (n === 0) return '0.0ms';
        if (n >= 1000) return (n / 1000).toFixed(2) + 's';
        return n.toFixed(1) + 'ms';
    }

    function rowClass(e) {
        if (!e) return '';

        // 1. Priority: a response type of 'Blocked' is always red.
        if (e.responseType === 'Blocked') return 'blocked';

        // 2. Secondary: check the RCODE for NXDOMAIN, Server Failure or Refused.
        const rcode = (e.rcode || '').toLowerCase().replace(/\s+/g, '');
        if (rcode === 'nxdomain') return 'nxdomain';
        if (rcode === 'serverfailure') return 'servfail';
        if (rcode === 'refused') return 'refused';

        return '';
    }

    function formatTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        return d.toLocaleTimeString('en-GB', { hour12: false });
    }

    return {
        init,
        add,
        scheduleRender,
        render,
        filterEntries,
        setColors,
        setPaused,
        setServerDisplayMap,
        setServerStatus,
    };
})();

export { Feed };
