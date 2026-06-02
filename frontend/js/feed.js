'use strict';

const Feed = (() => {
    let MAX_ENTRIES = 200;
    const entries = [];

    let renderTimer  = null;
    let lastFilter   = 'all';
    let lastBlocked  = false;
    let colorMap     = {};
    let paused       = false;

    function init(maxEntries) { if (maxEntries > 0) MAX_ENTRIES = maxEntries; }

    function setColors(map) {
        colorMap = map;
        const list = document.getElementById('feedList');
        if (list) list.innerHTML = '';
        render(lastFilter, lastBlocked);
    }

    function add(serverName, newEntries) {
        for (const e of newEntries) {
            entries.unshift({ ...e, _server: serverName });
        }
        if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
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
                    if (rcode === 'nxdomain')      entryType = 'NxDomain';
                    else if (rcode === 'serverfailure') entryType = 'ServerFailure';
                }
                
                if (!filters.has(entryType)) return false;
            }
            return true;
        });

        if (filtered.length === 0) {
            list.innerHTML = '<div class="no-data">Waiting for query data...</div>';
            return;
        }

        const existing = list.querySelectorAll('.feed-row');
        const existingIds = new Set([...existing].map(el => el.dataset.id));

        // Build fragment so we do one DOM insertion per batch, not one per row
        const frag = document.createDocumentFragment();
        let added = 0;
        for (const e of filtered.slice(0, MAX_ENTRIES)) {
            const id = `${e._server}:${e.rowNumber}`;
            if (existingIds.has(id)) continue;

            const row = document.createElement('div');
            row.className = 'feed-row ' + rowClass(e);
            row.dataset.id = id;

            const ts    = formatTime(e.timestamp);
            const srvCls  = colorMap[e._server] ? ' ' + colorMap[e._server] : '';
            
            // Determine badge text and class: Priority on Results (RCODE) over Resolution Method
            let badgeText = e.responseType || 'Unknown';
            let badgeCls  = badgeText.toLowerCase().replace(/\s+/g, '');
            
            const rcode = (e.rcode || '').toLowerCase().replace(/\s+/g, '');
            if (e.responseType !== 'Blocked') {
                if (rcode === 'nxdomain') {
                    badgeText = 'NX Domain';
                    badgeCls  = 'nxdomain';
                } else if (rcode === 'serverfailure') {
                    badgeText = 'ServFail';
                    badgeCls  = 'servfail';
                }
            }

            const rttVal  = e.responseRtt;
            const rtt     = fmtMs(rttVal, e.responseType);
            const latCls  = getLatClass(rttVal);

            row.innerHTML =
                '<span class="feed-time">'   + esc(ts)                  + '</span>' +
                '<span class="feed-server' + srvCls + '">' + esc(e._server) + '</span>' +
                '<span class="feed-client" title="' + esc(e.clientIpAddress) + '">' + esc(e.clientIpAddress) + '</span>' +
                '<span class="feed-proto">'  + esc(e.protocol || '')     + '</span>' +
                '<span class="feed-qtype">'  + esc(e.qtype || '')        + '</span>' +
                '<span class="feed-domain" title="' + esc(e.qname) + '">' + esc(e.qname) + '</span>' +
                '<span class="feed-latency ' + latCls + '">' + esc(rtt)  + '</span>' +
                '<span class="feed-type '   + badgeCls + '">'            + esc(badgeText) + '</span>';

            frag.appendChild(row);
            added++;
        }

        if (added > 0) {
            const placeholder = list.querySelector('.no-data');
            if (placeholder) placeholder.remove();
            list.insertBefore(frag, list.firstChild);
            // Trim overflow rows
            const rows = list.querySelectorAll('.feed-row');
            for (let i = MAX_ENTRIES; i < rows.length; i++) rows[i].remove();
        }
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
        if (instantTypes.includes(type) && (n == null || n === undefined || n === 0)) {
            return '0.0ms';
        }

        if (n == null || n === undefined) return '---';
        if (n === 0)   return '0.0ms';
        if (n >= 1000) return (n / 1000).toFixed(2) + 's';
        return n.toFixed(1) + 'ms';
    }

    function rowClass(e) {
        if (!e) return '';
        
        // 1. Priority: Response Type 'Blocked' is always Red
        if (e.responseType === 'Blocked') return 'blocked';
        
        // 2. Secondary: Check RCODE for NXDOMAIN (Orange) or Server Failure (Red)
        const rcode = (e.rcode || '').toLowerCase().replace(/\s+/g, '');
        if (rcode === 'nxdomain')      return 'nxdomain';
        if (rcode === 'serverfailure') return 'servfail';
        
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

    return { init, add, scheduleRender, render, setColors, setPaused, setFilters };
})();
