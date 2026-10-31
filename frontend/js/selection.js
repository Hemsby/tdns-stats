'use strict';

const Selection = (() => {
    const state = {
        tab: 'domains',
        selected: {
            domains: new Set(),
            blocked: new Set(),
            clients: new Set(),
        },
        anchor: {
            domains: null,
            blocked: null,
            clients: null,
        },
    };

    const TAB_LABELS = {
        domains: 'Domain',
        blocked: 'Blocked',
        clients: 'Client',
    };

    let onChange = null;
    let bound = false;

    function init(opts) {
        onChange = opts && typeof opts.onChange === 'function' ? opts.onChange : null;
        bind();
        renderUI();
    }

    function setTab(tab) {
        if (state.selected[tab]) state.tab = tab;
    }

    function getFilters() {
        return state.selected;
    }

    function clearAll() {
        for (const key of Object.keys(state.selected)) state.selected[key].clear();
        for (const key of Object.keys(state.anchor)) state.anchor[key] = null;
        commit();
    }

    function bind() {
        if (bound) return;
        bound = true;

        const content = document.getElementById('topContent');
        if (content) {
            content.addEventListener('click', handleRowClick);
            content.addEventListener('keydown', handleRowKeydown);
        }

        const bar = document.getElementById('feedSelectionBar');
        if (bar) bar.addEventListener('click', handleBarClick);

        document.addEventListener('keydown', handleDocumentKeydown, true);
    }

    function handleRowClick(e) {
        const row = e.target.closest('.top-row');
        if (!row) return;
        applyRow(row, {
            toggle: e.ctrlKey || e.metaKey,
            range: e.shiftKey,
        });
    }

    function handleRowKeydown(e) {
        if (e.key === 'Escape') {
            if (hasSelection()) {
                e.preventDefault();
                clearAll();
            }
            return;
        }

        const row = e.target.closest('.top-row');
        if (!row) return;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            moveFocus(row, e.key);
            return;
        }

        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        applyRow(row, {
            toggle: e.ctrlKey || e.metaKey,
            range: e.shiftKey,
        });
    }

    function handleDocumentKeydown(e) {
        if (e.key !== 'Escape' || !hasSelection()) return;
        if (isTextEntry(e.target)) return;

        const overlay = document.getElementById('changelogOverlay');
        if (overlay && !overlay.hidden) return;

        clearAll();
    }

    function handleBarClick(e) {
        if (e.target.closest('.feed-selection-clear')) {
            clearAll();
            return;
        }

        const chip = e.target.closest('.filter-chip');
        if (!chip) return;

        const tab = chip.dataset.tab;
        const name = chip.dataset.name;
        if (!state.selected[tab]) return;

        state.selected[tab].delete(name);
        if (state.anchor[tab] === name) state.anchor[tab] = null;
        commit();
    }

    function applyRow(row, action) {
        const tab = state.tab;
        const selected = state.selected[tab];
        const name = normalize(tab, row.dataset.name);
        if (!name) return;

        const rows = Array.from(row.parentElement.querySelectorAll('.top-row'));
        const index = rows.indexOf(row);

        if (action.range) {
            const anchorIndex = state.anchor[tab]
                ? rows.findIndex(r => normalize(tab, r.dataset.name) === state.anchor[tab])
                : -1;

            if (anchorIndex !== -1) {
                const start = Math.min(anchorIndex, index);
                const end = Math.max(anchorIndex, index);
                if (!action.toggle) selected.clear();
                for (let i = start; i <= end; i++) {
                    const rangeName = normalize(tab, rows[i].dataset.name);
                    if (rangeName) selected.add(rangeName);
                }
                commit();
                return;
            }
        }

        if (action.toggle) {
            if (selected.has(name)) selected.delete(name);
            else selected.add(name);
        } else if (selected.has(name)) {
            selected.delete(name);
        } else {
            selected.clear();
            selected.add(name);
        }

        state.anchor[tab] = name;
        commit();
    }

    function moveFocus(row, key) {
        const rows = Array.from(row.parentElement.querySelectorAll('.top-row'));
        const index = rows.indexOf(row);
        let next = index;

        if (key === 'ArrowDown') next = Math.min(index + 1, rows.length - 1);
        else if (key === 'ArrowUp') next = Math.max(index - 1, 0);
        else if (key === 'Home') next = 0;
        else if (key === 'End') next = rows.length - 1;

        if (rows[next]) rows[next].focus();
    }

    function isTextEntry(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }

    function hasSelection() {
        return state.selected.domains.size > 0 ||
            state.selected.blocked.size > 0 ||
            state.selected.clients.size > 0;
    }

    function commit() {
        renderUI();
        applyToRows();
        if (onChange) onChange(getFilters());
    }

    function applyToRows() {
        const content = document.getElementById('topContent');
        if (!content) return;

        const tab = state.tab;
        const selected = state.selected[tab];
        const rows = Array.from(content.querySelectorAll('.top-row'));
        const flags = rows.map(row => selected.has(normalize(tab, row.dataset.name)));

        rows.forEach((row, i) => {
            const isSelected = flags[i];
            row.classList.toggle('selected', isSelected);
            row.classList.toggle('sel-first', isSelected && !flags[i - 1]);
            row.classList.toggle('sel-last', isSelected && !flags[i + 1]);
            row.setAttribute('aria-selected', isSelected ? 'true' : 'false');
            row.title = isSelected ? 'Click to remove this filter' : 'Click to filter the live feed';
        });
    }

    function renderUI() {
        renderCount();
        renderBar();
    }

    function renderCount() {
        const el = document.getElementById('topSelectionCount');
        if (!el) return;

        const count = state.selected.domains.size +
            state.selected.blocked.size +
            state.selected.clients.size;

        el.hidden = count === 0;
        el.textContent = count === 1 ? '1 selected' : count + ' selected';
    }

    function renderBar() {
        const bar = document.getElementById('feedSelectionBar');
        if (!bar) return;

        const chips = [];
        for (const tab of Object.keys(state.selected)) {
            for (const name of state.selected[tab]) {
                chips.push(chipHtml(tab, name));
            }
        }

        bar.hidden = chips.length === 0;
        if (!chips.length) {
            bar.innerHTML = '';
            return;
        }

        bar.innerHTML = '<span class="feed-selection-label">Filtering</span>' +
            chips.join('') +
            '<button type="button" class="feed-selection-clear">Clear All</button>';
    }

    function chipHtml(tab, name) {
        return '<button type="button" class="filter-chip" data-tab="' + tab +
            '" data-name="' + esc(name) + '" title="Remove this filter">' +
            '<span class="filter-chip-label">' + TAB_LABELS[tab] + '</span>' +
            esc(name) +
            '<span class="filter-chip-x" aria-hidden="true">&times;</span>' +
            '</button>';
    }

    function normalize(tab, value) {
        const str = String(value == null ? '' : value).trim().toLowerCase();
        if (tab === 'clients') return str;
        return str.replace(/\.$/, '');
    }

    function esc(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    return { init, setTab, applyToRows, getFilters, clearAll };
})();
