'use strict';

/**
 * The helpers the dashboard shares.
 *
 * Every module that puts a name into the page, or a number on the screen,
 * needs the same few helpers, so they live here instead of being copied into
 * each one.
 */

/** The key the cluster is filed under. */
export const CLUSTER_KEY = '__cluster';

/** The key that means "the server the chart is showing". */
export const FOLLOW_CHART_KEY = '__follow_chart';

/** A string that is safe to put into the page as markup. */
export function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A domain name, the way the filters compare them. */
export function normalizeDomain(value) {
    return String(value == null ? '' : value)
        .trim()
        .toLowerCase()
        .replace(/\.$/, '');
}

/** A client address, the way the filters compare them. */
export function normalizeClient(value) {
    return String(value == null ? '' : value)
        .trim()
        .toLowerCase();
}

/** A count, shortened the way the cards show it. */
export function formatNumber(n) {
    if (n >= 1000000) return parseFloat((n / 1000000).toFixed(1)) + 'M';
    if (n >= 1000) return parseFloat((n / 1000).toFixed(1)) + 'K';
    return String(n);
}

/** A share, the way the cards show it. */
export function formatPercent(n) {
    if (n == null || n <= 0) return '--';
    return Number.isInteger(n) ? n + '%' : n.toFixed(1) + '%';
}

/** A duration, the way the cards show it. */
export function formatMs(n) {
    if (n == null) return '--';
    if (n >= 1000) return parseFloat((n / 1000).toFixed(2)) + 's';
    return parseFloat(n.toFixed(1)) + 'ms';
}

/** Bare millisecond value (no unit) for grids that carry the unit in their header. */
export function formatMsBare(n) {
    if (n == null) return '--';
    return String(parseFloat(n.toFixed(n < 100 ? 1 : 0)));
}

/** How long ago a timestamp was, the short way. */
export function relativeTime(isoStr) {
    const ms = Date.now() - new Date(isoStr).getTime();
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + (m % 60) + 'm';
    return Math.floor(h / 24) + 'd';
}

/** A link target that is safe to put in an href. */
export function safeUrl(url) {
    try {
        const p = new URL(url);
        return p.protocol === 'http:' || p.protocol === 'https:' ? url : '#';
    } catch (_) {
        return '#';
    }
}
