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

    function scheduleRender(serverFilter, blockedOnly) {
        lastFilter  = serverFilter;
        lastBlocked = blockedOnly;
        if (paused || renderTimer) return;
        renderTimer = setTimeout(() => {
            renderTimer = null;
            render(lastFilter, lastBlocked);
        }, 250);
    }

    function render(serverFilter, blockedOnly) {
        lastFilter  = serverFilter;
        lastBlocked = blockedOnly;

        const list = document.getElementById('feedList');
        if (!list) return;

        const filtered = entries.filter(e => {
            if (serverFilter !== 'all' && e._server !== serverFilter) return false;
            if (blockedOnly && e.responseType !== 'Blocked') return false;
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
            row.className = 'feed-row ' + rowClass(e.responseType);
            row.dataset.id = id;

            const ts    = formatTime(e.timestamp);
            const rtype = e.responseType || 'Unknown';
            const typeCls = rtype.toLowerCase().replace(/\s+/g, '');
            const srvCls  = colorMap[e._server] ? ' ' + colorMap[e._server] : '';

            row.innerHTML =
                '<span class="feed-time">'   + esc(ts)                  + '</span>' +
                '<span class="feed-server' + srvCls + '">' + esc(e._server) + '</span>' +
                '<span class="feed-client" title="' + esc(e.clientIpAddress) + '">' + esc(e.clientIpAddress) + '</span>' +
                '<span class="feed-proto">'  + esc(e.protocol || '')     + '</span>' +
                '<span class="feed-domain" title="' + esc(e.qname) + '">' + esc(e.qname) + '</span>' +
                '<span class="feed-type '   + typeCls + '">'             + esc(rtype) + '</span>';

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

    function rowClass(responseType) {
        switch (responseType) {
            case 'Blocked':      return 'blocked';
            case 'NxDomain':     return 'nxdomain';
            case 'ServerFailure':return 'servfail';
            default: return '';
        }
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

    return { init, add, scheduleRender, render, setColors, setPaused };
})();
