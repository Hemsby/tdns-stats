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

    function init(maxEntries) { if (maxEntries > 0) MAX_ENTRIES = maxEntries; }

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

        // Insert by timestamp descending (primary), with rowNumber descending
        // within the same server as a tiebreaker for equal timestamps.
        // Timestamp MUST take priority over rowNumber — entries from one server
        // that arrive with a newer timestamp than another server's existing entries
        // must go to the front, not to the old position of that server's prior entries.
        for (const entry of deduped) {
            const pos = entries.findIndex(e =>
                e._time < entry._time ||
                (e._time === entry._time && e._server === serverName && e.rowNumber < entry.rowNumber)
            );
            entries.splice(pos === -1 ? entries.length : pos, 0, entry);
        }

        // Evict oldest entries beyond MAX_ENTRIES
        if (entries.length > MAX_ENTRIES) {
            const evicted = entries.splice(MAX_ENTRIES);
            for (const ev of evicted) {
                const id = ev._server + ':' + ev.rowNumber;
                seen.delete(id);
            }
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
        for (let i = 0; i < max; i++) {
            const e = filtered[i];
            const row = document.createElement('div');
            row.className = 'feed-row ' + rowClass(e);
            row.dataset.id = `${e._server}:${e.rowNumber}`;

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
                } else if (rcode === 'refused') {
                    badgeText = 'Refused';
                    badgeCls  = 'refused';
                }
            }

            const rttVal  = e.responseRtt;
            const rtt     = fmtMs(rttVal, e.responseType);
            const latCls  = getLatClass(rttVal);

            const srvName = serverDisplayMap[e._server] || e._server;
            row.innerHTML =
                '<span class="feed-time">'   + esc(ts)                  + '</span>' +
                '<span class="feed-server' + srvCls + '" title="' + esc(e._server) + '">' + esc(srvName) + '</span>' +
                '<span class="feed-client" title="' + esc(e.clientIpAddress) + '">' + esc(e.clientIpAddress) + '</span>' +
                '<span class="feed-proto">'  + esc(e.protocol || '')     + '</span>' +
                '<span class="feed-qtype">'  + esc(e.qtype || '')        + '</span>' +
                '<span class="feed-domain" title="' + esc(e.qname) + '">' + esc(e.qname) + '</span>' +
                '<span class="feed-latency ' + latCls + '">' + esc(rtt)  + '</span>' +
                '<span class="feed-type '   + badgeCls + '">'            + esc(badgeText) + '</span>';

            frag.appendChild(row);
        }

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
