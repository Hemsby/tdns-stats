// Tests for frontend/js/feed.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { Feed } from '../js/feed.js';
import { Selection } from '../js/selection.js';

// The selection renders into the page, and there is no page here. Every
// element lookup comes back empty, which is the same as a dashboard where the
// top list has not been drawn yet.
globalThis.document = { getElementById: () => null };

const NO_FILTERS = new Set();

/** A row in the query log, the way the backend sends it on. */
function row(overrides = {}) {
    return {
        rowNumber: 1,
        timestamp: '2026-01-01T00:00:00Z',
        clientIpAddress: '89.160.20.112',
        protocol: 'Udp',
        responseType: 'Cached',
        rcode: 'NoError',
        qname: 'www.google.com',
        qtype: 'A',
        qclass: 'IN',
        answer: 'A 194.36.144.42',
        ...overrides,
    };
}

/** Wipe a server's rows and its dedup memory. */
function reset(server) {
    Feed.add(server, [], true);
}

test.describe('frontend/js/feed.js', () => {
    test.describe('rows', () => {
        test.it('keeps only the rows it has not seen before', () => {
            reset('dedup');
            const entry = row();

            Feed.add('dedup', [entry]);
            Feed.add('dedup', [entry]);

            assert.equal(Feed.filterEntries('dedup', NO_FILTERS).length, 1);

            // The same row number with a different timestamp is a different row.
            Feed.add('dedup', [row({ rowNumber: 7, timestamp: '2026-01-01T00:00:01Z' })]);

            assert.equal(Feed.filterEntries('dedup', NO_FILTERS).length, 2);

            // The rows of two servers are kept apart.
            reset('a');
            reset('b');
            Feed.add('a', [row()]);
            Feed.add('b', [row()]);

            assert.equal(Feed.filterEntries('a', NO_FILTERS).length, 1);
            assert.equal(Feed.filterEntries('b', NO_FILTERS).length, 1);
        });

        test.it('drops the rows the client had when the cursor resets', () => {
            reset('reset');
            Feed.add('reset', [row({ rowNumber: 1 })]);
            Feed.add('reset', [row({ rowNumber: 2 })]);

            // The log rotated: everything the client had is gone.
            Feed.add('reset', [row({ rowNumber: 3 })], true);

            const rows = Feed.filterEntries('reset', NO_FILTERS);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].rowNumber, 3);

            // At most the configured number of rows are kept, newest first.
            Feed.init(3);
            reset('cap');
            Feed.add('cap', [
                row({ rowNumber: 1, timestamp: '2026-01-01T00:00:01Z' }),
                row({ rowNumber: 2, timestamp: '2026-01-01T00:00:03Z' }),
                row({ rowNumber: 3, timestamp: '2026-01-01T00:00:02Z' }),
                row({ rowNumber: 4, timestamp: '2026-01-01T00:00:04Z' }),
            ]);

            const capped = Feed.filterEntries('cap', NO_FILTERS);
            assert.equal(capped.length, 3);
            assert.deepEqual(
                capped.map(r => r.rowNumber),
                [4, 2, 3],
            );
            Feed.init(200);
        });
    });

    test.describe('filters', () => {
        test.it('lets every row through when no type is chosen', () => {
            // Not 'all': that is the filter value that means every server.
            reset('unfiltered');
            Feed.add('unfiltered', [row({ rowNumber: 1, responseType: 'Cached' }), row({ rowNumber: 2, responseType: 'Blocked' })]);

            assert.equal(Feed.filterEntries('unfiltered', NO_FILTERS).length, 2);
        });

        test.it('picks the rows with the chosen response code', () => {
            reset('types');
            Feed.add('types', [
                row({ rowNumber: 1, responseType: 'Cached', rcode: 'NxDomain' }),
                row({ rowNumber: 2, responseType: 'Cached', rcode: 'ServerFailure' }),
                row({ rowNumber: 3, responseType: 'Blocked', rcode: 'NxDomain' }),
            ]);

            assert.deepEqual(
                Feed.filterEntries('types', new Set(['NxDomain'])).map(r => r.rowNumber),
                [1],
            );
            assert.deepEqual(
                Feed.filterEntries('types', new Set(['ServerFailure'])).map(r => r.rowNumber),
                [2],
            );

            // A blocked row is kept under the blocked filter.
            assert.deepEqual(
                Feed.filterEntries('types', new Set(['Blocked'])).map(r => r.rowNumber),
                [3],
            );

            // The rows that do not match the selection are left out.
            reset('selected');
            Feed.add('selected', [row({ rowNumber: 1, qname: 'mail.google.com' }), row({ rowNumber: 2, qname: 'api.github.com' })]);

            Selection.applyValue('domains', 'mail.google.com', { toggle: false });

            const rows = Feed.filterEntries('selected', NO_FILTERS);
            assert.deepEqual(
                rows.map(r => r.qname),
                ['mail.google.com'],
            );

            Selection.clearAll();
        });
    });
});
