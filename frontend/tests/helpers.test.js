// Tests for frontend/js/helpers.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { esc, normClient, normDomain, fmtNum, fmtPct, fmtMs, fmtMsBare, safeUrl } from '../js/helpers.js';

test.describe('frontend/js/helpers.js', () => {
    test.describe('markup', () => {
        test.it('escapes the characters that would make markup', () => {
            assert.equal(esc('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
            // An ampersand is escaped before anything else.
            assert.equal(esc('a & b'), 'a &amp; b');
            assert.equal(esc('&lt;'), '&amp;lt;');
        });

        test.it('gives an empty string for nothing', () => {
            assert.equal(esc(''), '');
            assert.equal(esc(null), '');
            assert.equal(esc(undefined), '');
        });
    });

    test.describe('names', () => {
        test.it('puts a name in the form the filters compare', () => {
            assert.equal(normDomain('  WWW.Wikipedia.ORG.  '), 'www.wikipedia.org');
            assert.equal(normClient(' 192.168.1.10 '), '192.168.1.10');
        });

        test.it('gives an empty string for nothing', () => {
            assert.equal(normDomain(null), '');
            assert.equal(normClient(undefined), '');
        });
    });

    test.describe('numbers', () => {
        test.it('shows a count, a share and a duration', () => {
            assert.equal(fmtNum(999), '999');
            assert.equal(fmtNum(1000), '1K');
            assert.equal(fmtNum(17569), '17.6K');
            assert.equal(fmtNum(1500000), '1.5M');
            assert.equal(fmtPct(45), '45%');
            assert.equal(fmtPct(45.56), '45.6%');
            assert.equal(fmtMs(12.34), '12.3ms');
            assert.equal(fmtMs(1500), '1.5s');
            assert.equal(fmtMsBare(12.34), '12.3');
            assert.equal(fmtMsBare(1234), '1234');
        });

        test.it('shows a dash when there is nothing to show', () => {
            assert.equal(fmtPct(null), '--');
            assert.equal(fmtPct(0), '--');
            assert.equal(fmtMs(null), '--');
            assert.equal(fmtMsBare(null), '--');
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
