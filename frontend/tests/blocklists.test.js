// Tests for frontend/js/blocklists.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { Blocklists } from '../js/blocklists.js';

const HAGEZI_LIGHT_URL = 'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/light-onlydomains.txt';
const OISD_URL = 'https://big.oisd.nl/domainswild2';

/** A blocked summary the way the backend sends it. */
function summary(overrides = {}) {
    return {
        server: 'ns1.home.arpa',
        domain: 'ads.doubleclick.net',
        ok: true,
        blocked: true,
        txtBlockingReport: true,
        lists: [],
        reportError: null,
        blockedMeta: {
            source: 'block-list-zone',
            group: undefined,
            parsed: { source: 'block-list-zone' },
            entries: [{ source: 'block-list-zone' }],
            raw: undefined,
        },
        ...overrides,
    };
}

/** A list the server reported. */
function list(name, url, extra = {}) {
    return { name, url, source: 'block-list-zone', group: '', nrdEnd: 0, matchedDomain: 'ads.doubleclick.net', ...extra };
}

test.describe('frontend/js/blocklists.js', () => {
    test.describe('blocked lookup card', () => {
        test.it('names every list the server reported', () => {
            const html = Blocklists.blockedSummary(
                summary({
                    lists: [list('HaGeZi Multi LIGHT', HAGEZI_LIGHT_URL), list('OISD Big', OISD_URL)],
                }),
                'ads.doubleclick.net',
            );

            assert.match(html, /HaGeZi Multi LIGHT/);
            assert.match(html, /OISD Big/);
            assert.equal((html.match(/blocked-list-item/g) || []).length, 2);
            assert.match(html, /status-badge danger">Blocked/);
            assert.match(html, /URL Blocklist/);

            // The list matched the name itself, not the name that was asked for.
            const sub = Blocklists.blockedSummary(
                summary({ lists: [list('HaGeZi Multi LIGHT', HAGEZI_LIGHT_URL, { matchedDomain: 'ads.doubleclick.net' })] }),
                'static.ads.doubleclick.net',
            );

            assert.match(sub, /Matched ads\.doubleclick\.net/);

            // A name that would make markup is escaped.
            const escaped = Blocklists.blockedSummary(
                summary({ lists: [list('<script>alert(1)</script>', HAGEZI_LIGHT_URL)] }),
                'ads.doubleclick.net',
            );

            assert.ok(!escaped.includes('<script>'), 'the name was not escaped');
            assert.match(escaped, /&lt;script&gt;/);
        });

        test.it('says the name is not blocked when no list was reported', () => {
            const clear = Blocklists.blockedSummary(
                summary({ blocked: false, blockedMeta: { parsed: {}, entries: [] } }),
                'ads.doubleclick.net',
            );

            assert.match(clear, /status-badge success">Not blocked/);
            assert.match(clear, /No block list reported/);

            // The report can be turned off on the server.
            const off = Blocklists.blockedSummary(summary({ blocked: true, txtBlockingReport: false }), 'ads.doubleclick.net');

            assert.match(off, /Allow TXT Blocking Report is off/);

            // A lookup that failed says so.
            const failed = Blocklists.blockedSummary(
                { server: 'ns1.home.arpa', ok: false, error: 'Lookup failed.' },
                'ads.doubleclick.net',
            );

            assert.match(failed, /status-badge neutral">Lookup failed/);
            assert.match(failed, /Lookup failed\./);
        });
    });

    test.describe('sources', () => {
        test.it('names the three sources in words', () => {
            assert.equal(Blocklists.formatSource('block-list-zone'), 'URL Blocklist');
            assert.equal(Blocklists.formatSource('blocked-zone'), 'Local Blocked Zone');
            assert.equal(Blocklists.formatSource('advanced-blocking-app'), 'Advanced Blocking App');
        });

        test.it('leaves an unknown source alone', () => {
            assert.equal(Blocklists.formatSource('Some Other App'), 'Some Other App');
        });
    });
});
