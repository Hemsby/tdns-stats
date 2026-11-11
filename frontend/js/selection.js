'use strict';

/**
 * The selection.
 *
 * The names the user has picked in the top lists, the range a shift-click
 * picks and the counters that say how much is selected.
 */

import { esc, normClient, normDomain } from './helpers.js';

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
    let topPresence = null;

    const LONG_PRESS_MS = 500;
    const MOVE_TOLERANCE = 10;
    let pressTimer = null;
    let pressStart = null;
    let pressAction = null;
    let suppressClickUntil = 0;

    // ---- Selection -------------------------------------------------------------------
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

    function setTopPresence(values) {
        if (!values) {
            topPresence = null;
            renderCount();
            return;
        }

        topPresence = {};
        for (const tab of Object.keys(state.selected)) {
            const names = values[tab];
            topPresence[tab] = names ? new Set(Array.from(names, name => normalize(tab, name)).filter(Boolean)) : null;
        }
        renderCount();
    }

    // ---- Mouse and touch -------------------------------------------------------------
    /**
     * The names a shift-click selects.
     *
     * A shift-click picks the rows from the anchor to the row that was clicked,
     * whichever way round they are. Without an anchor there is no range, and
     * the click is an ordinary one.
     */
    function rangeSelection(names, anchorIndex, index) {
        if (anchorIndex === -1) return null;
        const start = Math.min(anchorIndex, index);
        const end = Math.max(anchorIndex, index);
        return names.slice(start, end + 1);
    }

    function bind() {
        if (bound) return;
        bound = true;

        const content = document.getElementById('topContent');
        if (content) {
            content.addEventListener('click', handleRowClick);
            content.addEventListener('keydown', handleRowKeydown);
            bindLongPress(content);
        }

        const bar = document.getElementById('feedSelectionBar');
        if (bar) bar.addEventListener('click', handleBarClick);

        document.addEventListener('keydown', handleDocumentKeydown, true);
    }

    function isClickSuppressed() {
        return Date.now() < suppressClickUntil;
    }

    function handleRowClick(e) {
        if (isClickSuppressed()) return;
        if (e.target.closest('.top-row-action')) return;
        const row = e.target.closest('.top-row');
        if (!row) return;
        applyRow(row, {
            toggle: e.ctrlKey || e.metaKey,
            range: e.shiftKey,
        });
    }

    function bindLongPress(container) {
        container.addEventListener('pointerdown', e => {
            if (e.pointerType !== 'touch') return;
            const action = longPressAction(e.target);
            if (!action) return;

            cancelLongPress();
            pressStart = { x: e.clientX, y: e.clientY };
            pressAction = action;
            pressTimer = setTimeout(() => {
                pressTimer = null;
                const action = pressAction;
                pressAction = null;
                if (!action) return;
                suppressClickUntil = Date.now() + 700;
                applyValue(action.tab, action.value, { toggle: true });
            }, LONG_PRESS_MS);
        });

        container.addEventListener('pointermove', e => {
            if (!pressStart) return;
            if (Math.abs(e.clientX - pressStart.x) > MOVE_TOLERANCE || Math.abs(e.clientY - pressStart.y) > MOVE_TOLERANCE) {
                cancelLongPress();
            }
        });

        container.addEventListener('pointerup', cancelLongPress);
        container.addEventListener('pointercancel', cancelLongPress);
        container.addEventListener('pointerleave', cancelLongPress);
        container.addEventListener('contextmenu', e => {
            if (pressAction || isClickSuppressed()) e.preventDefault();
        });
    }

    function longPressAction(target) {
        if (target.closest('.top-row-action')) return null;
        const row = target.closest('.top-row');
        if (!row) return null;
        const name = normalize(state.tab, row.dataset.name);
        return name ? { tab: state.tab, value: name } : null;
    }

    function cancelLongPress() {
        clearTimeout(pressTimer);
        pressTimer = null;
        pressStart = null;
        pressAction = null;
    }

    // ---- Keyboard --------------------------------------------------------------------
    function handleRowKeydown(e) {
        if (e.key === 'Escape') {
            if (hasSelection()) {
                e.preventDefault();
                clearAll();
            }
            return;
        }

        if (e.target.closest('.top-row-action')) return;

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
        const name = normalize(tab, row.dataset.name);
        if (!name) return;

        if (action.range) {
            const selected = state.selected[tab];
            const rows = Array.from(row.parentElement.querySelectorAll('.top-row'));
            const index = rows.indexOf(row);
            const anchorIndex = state.anchor[tab] ? rows.findIndex(r => normalize(tab, r.dataset.name) === state.anchor[tab]) : -1;

            if (anchorIndex !== -1) {
                const names = rows.map(r => normalize(tab, r.dataset.name));
                const range = rangeSelection(names, anchorIndex, index);
                if (!action.toggle) selected.clear();
                for (const rangeName of range) {
                    if (rangeName) selected.add(rangeName);
                }
                commit();
                return;
            }
        }

        applyValue(tab, name, action);
    }

    function applyValue(tab, value, action) {
        const selected = state.selected[tab];
        if (!selected) return;
        const name = normalize(tab, value);
        if (!name) return;

        // The feed treats Domain and Blocked as one domain filter, so a value
        // held by either set counts as selected and a click removes it from
        // whichever set holds it.
        const holders = (tab === 'clients' ? [tab] : ['domains', 'blocked']).filter(t => state.selected[t].has(name));

        if (holders.length) {
            for (const t of holders) state.selected[t].delete(name);
        } else {
            if (!action.toggle) selected.clear();
            selected.add(name);
        }

        state.anchor[tab] = name;
        commit();
    }

    // ---- Counters and bars -----------------------------------------------------------
    /**
     * The row the focus moves to.
     *
     * The arrow keys move one row, Home and End go to the first and the last,
     * and the focus never leaves the list.
     */
    function nextFocusIndex(index, count, key) {
        if (key === 'ArrowDown') return Math.min(index + 1, count - 1);
        if (key === 'ArrowUp') return Math.max(index - 1, 0);
        if (key === 'Home') return 0;
        if (key === 'End') return count - 1;
        return index;
    }

    function moveFocus(row, key) {
        const rows = Array.from(row.parentElement.querySelectorAll('.top-row'));
        const index = rows.indexOf(row);
        const next = nextFocusIndex(index, rows.length, key);

        if (rows[next]) rows[next].focus();
    }

    function isTextEntry(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }

    function hasSelection() {
        return state.selected.domains.size > 0 || state.selected.blocked.size > 0 || state.selected.clients.size > 0;
    }

    function commit() {
        renderUI();
        if (onChange) onChange(getFilters());
    }

    function renderUI() {
        renderCount();
        renderBar();
    }

    /**
     * How many names are selected.
     *
     * When the top lists are on screen, only the names that are in them are
     * counted: a name that is selected but no longer on the list is not part of
     * what the feed is filtering.
     */
    function countSelected(selected, presence) {
        if (!presence) {
            return selected.domains.size + selected.blocked.size + selected.clients.size;
        }

        let count = 0;
        for (const tab of Object.keys(selected)) {
            const present = presence[tab];
            if (!present) continue;
            for (const name of selected[tab]) {
                if (present.has(name)) count++;
            }
        }
        return count;
    }

    function selectedCount() {
        return countSelected(state.selected, topPresence);
    }

    function renderCount() {
        const el = document.getElementById('topSelectionCount');
        if (!el) return;

        const count = selectedCount();
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

        bar.innerHTML =
            '<span class="feed-selection-label">Filtering</span>' +
            '<div class="feed-selection-chips">' +
            chips.join('') +
            '</div>' +
            '<button type="button" class="feed-selection-clear" title="Clear all filters">Clear All</button>';
    }

    function chipHtml(tab, name) {
        return (
            '<button type="button" class="filter-chip" data-tab="' +
            tab +
            '" data-name="' +
            esc(name) +
            '" title="Remove this filter">' +
            '<span class="filter-chip-label">' +
            TAB_LABELS[tab] +
            '</span>' +
            esc(name) +
            '<span class="filter-chip-x" aria-hidden="true">&times;</span>' +
            '</button>'
        );
    }

    function normalize(tab, value) {
        return tab === 'clients' ? normClient(value) : normDomain(value);
    }

    return {
        init,
        setTab,
        setTopPresence,
        applyValue,
        clearAll,
        getFilters,
        isClickSuppressed,
        rangeSelection,
        nextFocusIndex,
        countSelected,
    };
})();

export { Selection };
