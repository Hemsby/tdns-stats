// Tests for frontend/js/helpers.js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    escapeHtml,
    normalizeClient,
    normalizeDomain,
    formatNumber,
    formatPercent,
    formatMs,
    formatMsBare,
    safeUrl,
} from '../js/helpers.js';

test.describe('frontend/js/helpers.js', () => {
    test.describe('markup', () => {
        test.it('escapes the characters that would make markup', () => {
            assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
            // An ampersand is escaped before anything else.
            assert.equal(escapeHtml('a & b'), 'a &amp; b');
            assert.equal(escapeHtml('&lt;'), '&amp;lt;');
        });

        test.it('gives an empty string for nothing', () => {
            assert.equal(escapeHtml(''), '');
            assert.equal(escapeHtml(null), '');
            assert.equal(escapeHtml(undefined), '');
        });
    });

    test.describe('names', () => {
        test.it('puts a name in the form the filters compare', () => {
            assert.equal(normalizeDomain('  WWW.Wikipedia.ORG.  '), 'www.wikipedia.org');
            assert.equal(normalizeClient(' 192.168.1.10 '), '192.168.1.10');
        });

        test.it('gives an empty string for nothing', () => {
            assert.equal(normalizeDomain(null), '');
            assert.equal(normalizeClient(undefined), '');
        });
    });

    test.describe('numbers', () => {
        test.it('shows a count, a share and a duration', () => {
            assert.equal(formatNumber(999), '999');
            assert.equal(formatNumber(1000), '1K');
            assert.equal(formatNumber(17569), '17.6K');
            assert.equal(formatNumber(1500000), '1.5M');
            assert.equal(formatPercent(45), '45%');
            assert.equal(formatPercent(45.56), '45.6%');
            assert.equal(formatMs(12.34), '12.3ms');
            assert.equal(formatMs(1500), '1.5s');
            assert.equal(formatMsBare(12.34), '12.3');
            assert.equal(formatMsBare(1234), '1234');
        });

        test.it('shows a dash when there is nothing to show', () => {
            assert.equal(formatPercent(null), '--');
            assert.equal(formatPercent(0), '--');
            assert.equal(formatMs(null), '--');
            assert.equal(formatMsBare(null), '--');
        });
    });

    test.describe('links', () => {
        test.it('keeps an http link', () => {
            assert.equal(
                safeUrl('https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts'),
                'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
            );
        });

        test.it('drops anything that is not a link', () => {
            assert.equal(safeUrl('javascript:alert(1)'), '#');
            assert.equal(safeUrl('not a url'), '#');
        });
    });
});
