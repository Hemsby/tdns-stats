'use strict';

import { escapeHtml, formatNumber, CLUSTER_KEY } from './helpers.js';

/**
 * Everything to do with block lists.
 *
 * The popover that names the lists a domain is on, the card that shows what a
 * lookup found and the count of the queries each list caught.
 */
const Blocklists = (() => {
    /**
     * What the module needs from the app: the server the lookups run against,
     * whether the dashboard is showing a cluster, and the server the top lists
     * are showing.
     */
    let context = {
        searchServer: () => 'all',
        isCluster: () => false,
        topServer: () => null,
    };

    function init(ctx) {
        context = { ...context, ...(ctx || {}) };
        initTopBlockListActions();
        initBlockListCount();
    }

    // ---- Top-row popover -------------------------------------------------------------

    let topBlockListPopover = null;
    let topBlockListPopoverButton = null;
    let topBlockListPopoverTimer = null;

    function clearTopPopoverTimer() {
        if (topBlockListPopoverTimer) clearTimeout(topBlockListPopoverTimer);
        topBlockListPopoverTimer = null;
    }

    function closeTopBlockListPopover() {
        clearTopPopoverTimer();
        if (topBlockListPopoverButton) {
            topBlockListPopoverButton.removeEventListener('mouseleave', scheduleCloseTopBlockListPopover);
            topBlockListPopoverButton.classList.remove('top-row-action-open');
            topBlockListPopoverButton = null;
        }
        if (!topBlockListPopover) return;
        topBlockListPopover.remove();
        topBlockListPopover = null;
        document.removeEventListener('pointerdown', handleTopPopoverDismiss, true);
        document.removeEventListener('keydown', handleTopPopoverDismiss, true);
        window.removeEventListener('resize', closeTopBlockListPopover);
        window.removeEventListener('scroll', handleTopPopoverScroll, true);
    }

    function scheduleCloseTopBlockListPopover() {
        clearTopPopoverTimer();
        topBlockListPopoverTimer = setTimeout(closeTopBlockListPopover, 220);
    }

    function handleTopPopoverScroll(e) {
        if (topBlockListPopover?.contains(e.target)) return;
        closeTopBlockListPopover();
    }

    function handleTopPopoverDismiss(e) {
        if (e.type === 'keydown') {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
        } else if (topBlockListPopover?.contains(e.target) || e.target.closest?.('.top-row-action')) {
            return;
        }
        closeTopBlockListPopover();
    }

    function positionTopBlockListPopover(button, el) {
        const rect = button.getBoundingClientRect();
        const pad = 8;
        const width = el.offsetWidth;
        const height = el.offsetHeight;
        const left = Math.max(pad, Math.min(rect.right - width, window.innerWidth - width - pad));
        let top = rect.bottom + 6;
        if (top + height > window.innerHeight - pad) top = Math.max(pad, rect.top - height - 6);
        el.style.left = Math.round(left) + 'px';
        el.style.top = Math.round(top) + 'px';
    }

    async function showBlockListsFromTop(button, domain) {
        const name = String(domain || '').trim();
        if (!name) return;

        if (topBlockListPopover) {
            const same = topBlockListPopover.dataset.domain === name;
            closeTopBlockListPopover();
            if (same) return;
        }

        const effectiveServer = context.topServer();
        const sel = document.getElementById('domainSearchServerSelect');
        const allowed = sel ? Array.from(sel.options).map(option => option.value) : [];
        let target = effectiveServer || 'all';
        if (allowed.length && !allowed.includes(target)) target = context.isCluster() ? CLUSTER_KEY : 'all';

        const el = document.createElement('div');
        el.className = 'block-list-popover';
        el.dataset.domain = name;
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Blocklists for ' + name);
        el.style.visibility = 'hidden';
        document.body.appendChild(el);
        topBlockListPopover = el;
        topBlockListPopoverButton = button;
        button.classList.add('top-row-action-open');
        const setContent = html => {
            el.style.visibility = 'hidden';
            el.innerHTML = html;
            const title = el.querySelector('.block-list-popover-title');
            if (title) {
                const needed = title.scrollWidth + 26;
                el.style.width = Math.min(needed, window.innerWidth - 16) + 'px';
            } else {
                el.style.width = '';
            }
            positionTopBlockListPopover(button, el);
            el.style.visibility = '';
        };
        document.addEventListener('pointerdown', handleTopPopoverDismiss, true);
        document.addEventListener('keydown', handleTopPopoverDismiss, true);
        window.addEventListener('resize', closeTopBlockListPopover);
        window.addEventListener('scroll', handleTopPopoverScroll, true);
        if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
            button.addEventListener('mouseleave', scheduleCloseTopBlockListPopover);
            el.addEventListener('mouseenter', clearTopPopoverTimer);
            el.addEventListener('mouseleave', scheduleCloseTopBlockListPopover);
        }

        try {
            const url =
                '/api/cache/search?domain=' + encodeURIComponent(name) + '&server=' + encodeURIComponent(target) + '&blocked=1&cache=0';
            const res = await fetch(url, { cache: 'no-store' });
            const data = await res.json();
            if (!res.ok) throw new Error('Lookup failed.');
            if (topBlockListPopover !== el) return;

            const summary = data.blockedSummary;
            const lists = Array.isArray(summary?.lists) ? summary.lists : [];
            const names = [...new Set(lists.map(list => String(list.name || '').trim()).filter(Boolean))];
            if (!summary || !summary.ok) {
                setContent('<div class="block-list-popover-title">Lookup failed.</div>');
            } else if (!names.length) {
                setContent('<div class="block-list-popover-title">No block list reported.</div>');
            } else {
                setContent(
                    `<div class="block-list-popover-title">Appears on the following blocklist(s):</div><div class="block-list-popover-names">${names.map(listName => `<div class="block-list-popover-name">- ${escapeHtml(listName)}</div>`).join('')}</div>`,
                );
            }
        } catch {
            if (topBlockListPopover !== el) return;
            setContent('<div class="block-list-popover-title">Lookup failed.</div>');
        }
    }

    function initTopBlockListActions() {
        const content = document.getElementById('topContent');
        if (!content || content.dataset.ready === 'true') return;
        content.dataset.ready = 'true';
        content.addEventListener('click', e => {
            const btn = e.target.closest('.top-row-action');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            const row = btn.closest('.top-row');
            showBlockListsFromTop(btn, btn.dataset.name || row?.dataset.name || '');
        });
    }

    // ---- Blocked lookup card ---------------------------------------------------------

    function formatBlockedSource(value) {
        const normalized = String(value || '')
            .trim()
            .toLowerCase();
        if (!normalized) return value;
        return normalized === 'block-list-zone'
            ? 'URL Blocklist'
            : normalized === 'blocked-zone'
              ? 'Local Blocked Zone'
              : normalized === 'advanced-blocking-app'
                ? 'Advanced Blocking App'
                : value;
    }

    function renderBlockedLookupSummary(node, queryDomain) {
        const parsedEntries =
            Array.isArray(node.blockedMeta?.entries) && node.blockedMeta.entries.length
                ? node.blockedMeta.entries
                : node.blockedMeta?.parsed
                  ? [node.blockedMeta.parsed]
                  : [];
        const labelMap = {
            source: 'Source',
            group: 'Group',
            blockreason: 'Reason',
            reason: 'Reason',
        };
        const skipKeys = new Set(['domain', 'raw', 'blocklisturl', 'blocklist', 'block list']);

        const splitValues = value => {
            if (typeof value !== 'string') return [String(value)];
            const parts = value
                .split(/[,;]\s*/)
                .map(v => v.trim())
                .filter(Boolean);
            return parts.length ? parts : [value];
        };

        const detailMap = new Map();
        parsedEntries.forEach(entry => {
            for (const [key, value] of Object.entries(entry || {})) {
                if (!value) continue;
                const normalized = key.toLowerCase();
                if (skipKeys.has(normalized) || !labelMap[normalized]) continue;

                const label = labelMap[normalized];
                const displayValue = normalized === 'source' ? formatBlockedSource(value) : value;
                const values = splitValues(displayValue).map(v => escapeHtml(v));

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

        const fromAdvancedBlocking = parsedEntries.some(
            entry =>
                String(entry?.source || '')
                    .trim()
                    .toLowerCase() === 'advanced-blocking-app',
        );
        if (fromAdvancedBlocking) {
            details.push({
                label: 'Note',
                value: 'The Advanced Blocking App reports only the first matching list, so this name may be on more lists.',
            });
        }

        const lists = Array.isArray(node.lists) ? node.lists : [];
        const asked = String(queryDomain || '')
            .replace(/\.+$/, '')
            .toLowerCase();
        const listHtml = lists
            .map(list => {
                const url = list.url ? '<div class="block-list-url">' + escapeHtml(list.url) + '</div>' : '';
                const matched = String(list.matchedDomain || '')
                    .replace(/\.+$/, '')
                    .toLowerCase();
                const match =
                    list.matchedDomain && matched !== asked
                        ? '<div class="block-list-match">Matched ' + escapeHtml(list.matchedDomain) + '</div>'
                        : '';
                return `<div class="block-list-item"><div class="block-list-name">${escapeHtml(list.name || 'Block list')}</div>${url}${match}</div>`;
            })
            .join('');

        // The backend says whether the name was blocked, so the card does not
        // have to work it out from the report a second time.
        const isBlocked = Boolean(node.blocked);
        const statusBadge = node.ok
            ? isBlocked
                ? '<span class="status-badge danger">Blocked</span>'
                : '<span class="status-badge success">Not blocked</span>'
            : '<span class="status-badge neutral">Lookup failed</span>';

        let note = '';
        if (!node.ok) {
            note = '<div class="block-list-note">' + escapeHtml(node.error || 'Lookup failed') + '</div>';
        } else if (node.reportError) {
            note = '<div class="block-list-note">' + escapeHtml(node.reportError) + '</div>';
        } else if (lists.length) {
            // The Note row above already covers Advanced Blocking results, and manual
            // entries have no overlap to explain. Only built-in URL lists get this line.
            const hasUrlList = lists.some(
                list =>
                    String(list.source || '')
                        .trim()
                        .toLowerCase() === 'block-list-zone',
            );
            if (hasUrlList && !fromAdvancedBlocking) {
                note = '<div class="block-list-note">Every built-in block list that matched is shown.</div>';
            }
        } else if (isBlocked) {
            note = `<div class="block-list-note">${node.txtBlockingReport === false ? 'Allow TXT Blocking Report is off, so built-in block lists cannot be reported.' : 'No block list was reported. The Advanced Blocking app only names the first matching list, and a manual block may have no list URL.'}</div>`;
        } else {
            note = `<div class="block-list-note">${node.txtBlockingReport === true ? 'No block list reported. The name is not blocked.' : node.txtBlockingReport === false ? 'Allow TXT Blocking Report is off, so built-in block lists cannot be reported. This name may still be blocked.' : 'No block list reported. The name is not blocked, or Allow TXT Blocking Report is off.'}</div>`;
        }

        const detailHtml = details.length
            ? details
                  .map(
                      item =>
                          `<div class="blocked-lookup-meta-row"><span class="blocked-lookup-meta-label">${item.label ? escapeHtml(item.label + ':') : '&nbsp;'}</span><span class="blocked-lookup-meta-value">${item.value}</span></div>`,
                  )
                  .join('')
            : '';

        return `<article class="blocked-lookup-card"><div class="blocked-lookup-card-header"><div class="blocked-lookup-card-title">${escapeHtml(node.server)}</div><div>${statusBadge}</div></div>${listHtml ? `<div class="block-list">${listHtml}</div>` : ''}${detailHtml ? `<div class="blocked-lookup-card-meta">${detailHtml}</div>` : ''}${note}</article>`;
    }

    // ---- Scope and counting ----------------------------------------------------------

    function blockListScope() {
        const serverSelect = document.getElementById('domainSearchServerSelect');
        const server = serverSelect?.value || context.searchServer() || 'all';
        let label;
        let scope;
        if (server === CLUSTER_KEY && context.isCluster()) {
            label = 'Cluster';
            scope = 'the cluster';
        } else if (server === 'all' || server === CLUSTER_KEY) {
            label = 'All servers';
            scope = 'all servers';
        } else {
            label = serverSelect?.selectedOptions?.[0]?.text || server;
            scope = label;
        }
        return { server, scope, label, key: server };
    }

    // Each server (and the cluster) keeps its own last count, so switching the
    // search selection shows that scope's result, or a blank card if it has none.
    const blockListResults = new Map();
    let blockListCounting = null;

    function showBlockListResult() {
        const el = document.getElementById('blockListTotals');
        if (!el) return;
        const { key } = blockListScope();
        if (blockListCounting === key) {
            el.innerHTML = '<div class="block-list-empty">Reading the blocked log...</div>';
            return;
        }
        const stored = blockListResults.get(key);
        if (stored) renderBlockListTotals(stored.data, stored.scope);
        else el.innerHTML = 'Not counted yet.';
    }

    function updateBlockListScope() {
        const pill = document.getElementById('blockListScopePill');
        if (!pill) return;
        const { label } = blockListScope();
        pill.textContent = label;
        showBlockListResult();
    }

    function renderBlockListTotals(data, scope) {
        const el = document.getElementById('blockListTotals');
        if (!el) return;
        if (!data) {
            el.innerHTML = 'Not counted yet.';
            return;
        }
        if (data.error && !data.ok) {
            el.innerHTML = '<div class="block-list-empty">' + escapeHtml(data.error) + '</div>';
            return;
        }

        const lists = Array.isArray(data.lists) ? data.lists : [];
        const extras = [];
        if (data.unmatched?.hits)
            extras.push({ name: 'No list reported', hits: data.unmatched.hits, domains: data.unmatched.domains, dim: true });
        if (data.unresolved?.hits)
            extras.push({ name: 'Lookup failed', hits: data.unresolved.hits, domains: data.unresolved.domains, dim: true });
        const max = Math.max(1, ...lists.map(list => list.hits || 0), ...extras.map(list => list.hits || 0));

        function row(list) {
            const hits = list.hits || 0;
            const pct = Math.max(hits ? 2 : 0, Math.round((hits / max) * 100));
            const names = list.domains ? ' · ' + formatNumber(list.domains) + (list.domains === 1 ? ' name' : ' names') : '';
            const queries = formatNumber(hits) + (hits === 1 ? ' query' : ' queries');
            const title = list.url ? ' title="' + escapeHtml(list.url) + '"' : '';
            return `<div class="block-list-stat-row${list.dim ? ' dim' : ''}"${title}><div class="block-list-stat-top"><span class="block-list-stat-name">${escapeHtml(list.name || 'Block list')}</span><span class="block-list-stat-hits">${escapeHtml(queries + names)}</span></div><div class="block-list-stat-bar"><span style="width:${pct}%"></span></div></div>`;
        }

        const when = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
        const exact = n => Number(n || 0).toLocaleString();
        const looked = `Last hour. This click sent ${exact(data.lookups)}${data.lookups === 1 ? ' lookup' : ' lookups'}${data.cacheHits ? ` and reused ${exact(data.cacheHits)} cached names.` : '.'}`;
        const extraNotes = [];
        if (data.truncated) {
            const scanned = data.blockedQueries || 0;
            const pages = data.totalPages > 0 ? ' (' + exact(data.pagesFetched) + ' of ' + exact(data.totalPages) + ' pages)' : '';
            extraNotes.push(
                scanned
                    ? 'Showing newest ' + exact(scanned) + ' blocked entries' + pages + '.'
                    : 'Showing the newest blocked queries only.',
            );
        }
        if (data.limited?.names) {
            const limit = data.lookupLimit || 0;
            extraNotes.push(
                `Top ${exact(limit)} names by hits; ${exact(data.limited.names)}${data.limited.names === 1 ? ' name / ' : ' names / '}${exact(data.limited.hits)}${data.limited.hits === 1 ? ' hit excluded.' : ' hits excluded.'}`,
            );
        }
        const body =
            lists.length || extras.length
                ? lists.map(row).join('') + extras.map(row).join('')
                : '<div class="block-list-empty">No blocked queries in the last hour.</div>';

        el.innerHTML = `<div class="block-list-stats-head"><span>${formatNumber(data.blockedQueries || 0)} blocked queries counted${data.skippedLoopback ? `, ${formatNumber(data.skippedLoopback)} skipped from 127.0.0.1 and ::1` : ''}</span>${when ? `<span class="block-list-stats-time">Counted for ${escapeHtml(scope || 'the cluster')} at ${escapeHtml(when)}</span>` : ''}</div>${lists.length || extras.length ? '<div class="block-list-stat-cols"><span>Block list</span><span>Queries · distinct names</span></div>' : ''}${body}<div class="block-list-stats-note">${escapeHtml(looked)}${extraNotes.length ? `<br>${escapeHtml(extraNotes.join(' '))}` : ''}</div>`;
    }

    async function countBlockLists() {
        const btn = document.getElementById('countBlockListsBtn');
        const { server, scope, key } = blockListScope();
        if (btn) btn.disabled = true;
        blockListCounting = key;
        showBlockListResult();
        try {
            const res = await fetch('/api/block-list-stats?server=' + encodeURIComponent(server), {
                method: 'POST',
                cache: 'no-store',
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Count failed');
            blockListResults.set(key, { data, scope });
        } catch (e) {
            blockListResults.set(key, { data: { ok: false, error: e.message || 'Count failed' }, scope });
        } finally {
            blockListCounting = null;
            if (btn) btn.disabled = false;
            showBlockListResult();
        }
    }

    function initBlockListCount() {
        const btn = document.getElementById('countBlockListsBtn');
        if (!btn || btn.dataset.ready === 'true') return;
        btn.dataset.ready = 'true';
        btn.addEventListener('click', e => {
            e.preventDefault();
            countBlockLists();
        });
    }

    return {
        init,
        updateScope: updateBlockListScope,
        scope: blockListScope,
        blockedSummary: renderBlockedLookupSummary,
        formatSource: formatBlockedSource,
        showFromTop: showBlockListsFromTop,
        count: countBlockLists,
    };
})();

export { Blocklists };
