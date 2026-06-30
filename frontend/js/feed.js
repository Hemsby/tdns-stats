'use strict';

const Feed = (() => {
    let MAX_ENTRIES = 200;
    const entries = [];
    const seen   = new Set();

    let renderTimer  = null;
    let lastFilter   = 'all';
    let lastBlocked  = false;
    let colorMap     = {};
    let paused       = false;
    let serverDisplayMap = {};
    const textCtx = document.createElement('canvas').getContext('2d');
    textCtx.font = '600 11px "Chakra Petch", system-ui, sans-serif';

    function init(maxEntries) {
        if (maxEntries > 0) MAX_ENTRIES = maxEntries;
    }

    function setServerDisplayMap(map) { serverDisplayMap = map; }

    function setColors(map) {
        colorMap = map;
        const list = document.getElementById('feedList');
        if (list) list.innerHTML = '';
        render(lastFilter, lastBlocked);
    }

    function add(serverName, newEntries, cursorReset) {
        if (cursorReset) {
            // Log rotated — clear all seen IDs and entries for this server
            let writeIdx = 0;
            for (let i = 0; i < entries.length; i++) {
                if (entries[i]._server === serverName) {
                    seen.delete(entries[i]._server + ':' + entries[i].rowNumber);
                } else {
                    entries[writeIdx++] = entries[i];
                }
            }
            entries.length = writeIdx;
        }

        const deduped = [];
        for (const e of newEntries) {
            const id = serverName + ':' + e.rowNumber;
            if (seen.has(id)) continue;
            seen.add(id);
            deduped.push({ ...e, _server: serverName, _time: new Date(e.timestamp).getTime() });
        }
        if (deduped.length === 0) return;

        // Merge new entries into the sorted array in O(n + m) instead of O(n × m).
        // Both `entries` and `deduped` are sorted by _time descending. Sort deduped
        // explicitly since we shouldn't assume API ordering across edge cases.
        deduped.sort((a, b) => b._time - a._time || b.rowNumber - a.rowNumber);

        const merged = [];
        let i = 0, j = 0;
        while (i < entries.length && j < deduped.length) {
            const e = entries[i];
            const d = deduped[j];
            if (d._time > e._time ||
                (d._time === e._time && d._server === e._server && d.rowNumber > e.rowNumber)) {
                merged.push(d);
                j++;
            } else {
                merged.push(e);
                i++;
            }
        }
        while (i < entries.length) merged.push(entries[i++]);
        while (j < deduped.length) merged.push(deduped[j++]);

        // Replace entries contents and evict beyond MAX_ENTRIES
        const limit = Math.min(merged.length, MAX_ENTRIES);
        entries.length = 0;
        for (let k = 0; k < limit; k++) entries.push(merged[k]);
        for (let k = limit; k < merged.length; k++) {
            seen.delete(merged[k]._server + ':' + merged[k].rowNumber);
        }
    }

    // Debounce: batch rapid feed updates from multiple servers into one render
    function setPaused(p) {
        paused = p;
        if (!paused) render(lastFilter, lastBlocked);
    }

    function setFilters(filters) {
        lastBlocked = filters;
        render(lastFilter, filters);
    }

    function scheduleRender(serverFilter, filters) {
        lastFilter  = serverFilter;
        lastBlocked = filters;
        if (paused || renderTimer) return;
        renderTimer = setTimeout(() => {
            renderTimer = null;
            render(lastFilter, lastBlocked);
        }, 250);
    }

    function render(serverFilter, filters) {
        lastFilter  = serverFilter;
        lastBlocked = filters;

        const list = document.getElementById('feedList');
        if (!list) return;

        const filtered = entries.filter(e => {
            if (serverFilter !== 'all' && e._server !== serverFilter) return false;
            if (filters.size > 0) {
                // Determine what this entry "is" based on our priority logic
                let entryType = e.responseType;
                const rcode = (e.rcode || '').toLowerCase().replace(/\s+/g, '');
                
                if (entryType !== 'Blocked') {
                    if (rcode === 'nxdomain')         entryType = 'NxDomain';
                    else if (rcode === 'serverfailure') entryType = 'ServerFailure';
                    else if (rcode === 'refused')       entryType = 'Refused';
                }
                
                if (!filters.has(entryType)) return false;
            }
            return true;
        });

        if (filtered.length === 0) {
            list.innerHTML = '<div class="no-data">Waiting for query data...</div>';
            return;
        }

        const frag = document.createDocumentFragment();
        const max = Math.min(filtered.length, MAX_ENTRIES);
        let maxSrvW = 0;
        for (let i = 0; i < max; i++) {
            const e = filtered[i];
            const srvName = serverDisplayMap[e._server] || e._server;
            const w = Math.ceil(textCtx.measureText(srvName).width + srvName.length * 0.2) + 8;
            if (w > maxSrvW) maxSrvW = w;

            let badgeText = e.responseType || 'Unknown';
            const rcode = (e.rcode || '').toLowerCase().replace(/\s+/g, '');
            if (e.responseType !== 'Blocked') {
                if (rcode === 'nxdomain')         badgeText = 'NX Domain';
                else if (rcode === 'serverfailure') badgeText = 'ServFail';
                else if (rcode === 'refused')       badgeText = 'Refused';
            }


            const row = document.createElement('div');
            row.className = 'feed-row ' + rowClass(e);
            row.dataset.id = `${e._server}:${e.rowNumber}`;

            const ts    = formatTime(e.timestamp);
            const srvCls  = colorMap[e._server] ? ' ' + colorMap[e._server] : '';
            const badgeCls  = badgeText.toLowerCase().replace(/\s+/g, '');

            const rttVal  = e.responseRtt;
            const rtt     = fmtMs(rttVal, e.responseType);
            const latCls  = getLatClass(rttVal);

            row.innerHTML =
                '<span class="feed-time">'   + esc(ts)                  + '</span>' +
                '<span class="feed-server' + srvCls + '" title="' + esc(e._server) + '">' + esc(srvName) + '</span>' +
                '<span class="feed-client" title="' + esc(e.clientIpAddress) + '">' + esc(e.clientIpAddress) + '</span>' +
                '<span class="feed-proto">'  + esc(e.protocol || '')     + '</span>' +
                '<span class="feed-qtype">'  + esc(e.qtype || '')        + '</span>' +
                '<span class="feed-domain" title="' + esc(e.qname) + '">' + esc(e.qname) + '</span>' +
                '<span class="feed-latencytype"><span class="feed-latency ' + latCls + '">' + esc(rtt)  + '</span>' +
                '<span class="feed-type '   + badgeCls + '">'            + esc(badgeText) + '</span></span>';

            frag.appendChild(row);
        }
        maxSrvW = Math.min(maxSrvW, 60);

        list.style.setProperty('--srv-w', maxSrvW + 'px');
        list.replaceChildren(frag);
    }

    function getLatClass(n) {
        if (n == null || n <= 0) return '';
        if (n <= 20)  return 'lat-low';
        if (n <= 100) return 'lat-mid';
        return 'lat-high';
    }

    function fmtMs(n, type) {
        // If it's not a recursive query, it's effectively 0ms latency from the server's perspective
        const instantTypes = ['Cached', 'Blocked', 'Authoritative', 'Refused', 'Dropped'];
        if (instantTypes.includes(type)) {
            return '';
        }

        if (n == null || n === undefined || !Number.isFinite(n)) return '';
        if (n === 0)   return '0.0ms';
        if (n >= 1000) return (n / 1000).toFixed(2) + 's';
        return n.toFixed(1) + 'ms';
    }

    function rowClass(e) {
        if (!e) return '';
        
        // 1. Priority: Response Type 'Blocked' is always Red
        if (e.responseType === 'Blocked') return 'blocked';
        
        // 2. Secondary: Check RCODE for NXDOMAIN, Server Failure, or Refused
        const rcode = (e.rcode || '').toLowerCase().replace(/\s+/g, '');
        if (rcode === 'nxdomain')      return 'nxdomain';
        if (rcode === 'serverfailure') return 'servfail';
        if (rcode === 'refused')       return 'refused';
        
        return '';
    }

    function formatTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        return d.toLocaleTimeString('en-GB', { hour12: false });
    }

    function esc(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    return { init, add, scheduleRender, render, setColors, setPaused, setFilters, setServerDisplayMap };
})();
