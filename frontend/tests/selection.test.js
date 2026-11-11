// Tests for frontend/js/selection.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { Selection } from '../js/selection.js';

// The selection renders into the page, and there is no page here. Every
// element lookup comes back empty, which is the same as a dashboard where the
// top list has not been drawn yet.
globalThis.document = { getElementById: () => null };

const filters = () => Selection.getFilters();

// The names a real top list shows.
const TOP_ROWS = ['www.google.com', 'www.youtube.com', 'cdn.adsrvr.org', 'mail.google.com'];

test.describe('frontend/js/selection.js', () => {
    test.describe('a click', () => {
        test.it('replaces the selection on a plain click and adds to it on a modified one', () => {
            Selection.clearAll();

            Selection.applyValue('domains', 'www.google.com', { toggle: false });
            Selection.applyValue('domains', 'www.youtube.com', { toggle: false });

            assert.deepEqual([...filters().domains], ['www.youtube.com']);

            Selection.applyValue('domains', 'www.google.com', { toggle: true });

            assert.deepEqual([...filters().domains].sort(), ['www.google.com', 'www.youtube.com']);

            // The clients are kept in a filter of their own.
            Selection.applyValue('clients', '89.160.20.112', { toggle: false });

            assert.deepEqual([...filters().clients], ['89.160.20.112']);
        });

        test.it('removes a name that is clicked twice', () => {
            Selection.clearAll();

            Selection.applyValue('domains', 'www.google.com', { toggle: false });
            Selection.applyValue('domains', 'www.google.com', { toggle: true });

            assert.equal(filters().domains.size, 0);

            // The feed treats Domain and Blocked as one domain filter, so a name
            // the blocked filter already holds is removed from the domain filter.
            Selection.applyValue('domains', 'www.google.com', { toggle: false });
            Selection.applyValue('blocked', 'www.google.com', { toggle: true });

            assert.equal(filters().domains.size, 0);
            assert.equal(filters().blocked.size, 0);

            // Names are compared without their case or their trailing dot.
            Selection.applyValue('domains', 'WWW.Wikipedia.ORG', { toggle: false });
            Selection.applyValue('domains', 'www.wikipedia.org.', { toggle: true });

            assert.equal(filters().domains.size, 0);
        });
    });

    test.describe('clearing the selection', () => {
        test.it('empties every filter when the selection is cleared', () => {
            Selection.applyValue('domains', 'www.google.com', { toggle: false });
            Selection.applyValue('clients', '89.160.20.112', { toggle: false });

            Selection.clearAll();

            assert.equal(filters().domains.size, 0);
            assert.equal(filters().blocked.size, 0);
            assert.equal(filters().clients.size, 0);
        });

        test.it('leaves the selection empty when there was nothing to clear', () => {
            Selection.clearAll();

            Selection.applyValue('domains', 'www.google.com', { toggle: false });
            Selection.clearAll();
            Selection.clearAll();

            assert.equal(filters().domains.size, 0);
            assert.equal(filters().blocked.size, 0);
            assert.equal(filters().clients.size, 0);
        });
    });

    test.describe('a range of rows', () => {
        test.it('takes the rows from the anchor to the row that was clicked', () => {
            assert.deepEqual(Selection.rangeSelection(TOP_ROWS, 0, 2), ['www.google.com', 'www.youtube.com', 'cdn.adsrvr.org']);
            assert.deepEqual(Selection.rangeSelection(TOP_ROWS, 1, 3), ['www.youtube.com', 'cdn.adsrvr.org', 'mail.google.com']);
            // The same rows, whichever way round they are clicked.
            assert.deepEqual(Selection.rangeSelection(TOP_ROWS, 2, 0), Selection.rangeSelection(TOP_ROWS, 0, 2));
        });

        test.it('takes nothing when there is no anchor to range from', () => {
            // Without an anchor the click is an ordinary one, not a range.
            assert.equal(Selection.rangeSelection(TOP_ROWS, -1, 2), null);
        });
    });

    test.describe('keyboard', () => {
        test.it('moves the focus one row with the arrow keys and to the ends with Home and End', () => {
            // Three rows, so the focus can move down and back up.
            assert.equal(Selection.nextFocusIndex(0, 3, 'ArrowDown'), 1);
            assert.equal(Selection.nextFocusIndex(2, 3, 'ArrowUp'), 1);
            assert.equal(Selection.nextFocusIndex(2, 3, 'Home'), 0);
            assert.equal(Selection.nextFocusIndex(0, 3, 'End'), 2);
        });

        test.it('never moves the focus off the ends of the list', () => {
            assert.equal(Selection.nextFocusIndex(0, 3, 'ArrowUp'), 0);
            assert.equal(Selection.nextFocusIndex(2, 3, 'ArrowDown'), 2);
            // A key the list does not use leaves the focus where it is.
            assert.equal(Selection.nextFocusIndex(1, 3, 'Enter'), 1);
        });
    });

    test.describe('selected names', () => {
        test.it('counts every selected name when there is no top list', () => {
            Selection.clearAll();
            Selection.applyValue('domains', 'www.google.com', { toggle: false });
            Selection.applyValue('clients', '89.160.20.112', { toggle: false });

            assert.equal(Selection.countSelected(Selection.getFilters(), null), 2);
        });

        test.it('counts only the names that are in the top list', () => {
            Selection.clearAll();
            Selection.applyValue('domains', 'www.google.com', { toggle: false });
            Selection.applyValue('domains', 'www.youtube.com', { toggle: true });

            // The top list shows the first name but not the second.
            const presence = { domains: new Set(['www.google.com']), blocked: null, clients: null };

            assert.equal(Selection.countSelected(Selection.getFilters(), presence), 1);
            Selection.clearAll();
        });
    });
});
