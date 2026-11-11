// Tests for frontend/js/charts.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { Charts } from '../js/charts.js';

const pad = n => String(n).padStart(2, '0');

/** The local time of an ISO stamp, the way a clock on the wall shows it. */
function localTime(iso) {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

test.describe('frontend/js/charts.js', () => {
    test.describe('labels', () => {
        test.it('shows the time the way the clock does', () => {
            assert.deepEqual(Charts.formatLabels(['2026-01-01T13:07:00Z'], 'HH:mm'), [localTime('2026-01-01T13:07:00Z')]);

            // The longer ranges are shown in UTC.
            assert.deepEqual(Charts.formatLabels(['2026-01-09T13:07:00Z'], 'dd/MM'), ['09/01']);
            assert.deepEqual(Charts.formatLabels(['2026-01-09T13:07:00Z'], 'MM/yyyy'), ['01/2026']);

            // The backend shifts the labels by the offset of the browser, so the
            // chart reads them as the local clock does.
            const shifted = new Date('2026-01-09T13:07:00Z');
            assert.deepEqual(Charts.formatLabels(['2026-01-09T13:07:00Z'], 'dd/MM', 120), [
                `${pad(shifted.getDate())}/${pad(shifted.getMonth() + 1)}`,
            ]);
        });

        test.it('leaves a label it cannot read alone', () => {
            assert.deepEqual(Charts.formatLabels(['not a date'], 'HH:mm'), ['not a date']);

            // With no format there is nothing to show.
            const labels = ['2026-01-01T13:07:00Z'];
            assert.equal(Charts.formatLabels(labels, null), labels);
        });
    });

    test.describe('dataset sets', () => {
        test.it('knows every label the server sends', () => {
            assert.deepEqual(Object.keys(Charts.DATASET_COLORS), [
                'Total',
                'No Error',
                'Blocked',
                'Cached',
                'Recursive',
                'Authoritative',
                'NX Domain',
                'Server Failure',
                'Dropped',
                'Clients',
                'Refused',
            ]);
        });

        test.it('shows the headline counters in the overview and every one in the all view', () => {
            assert.deepEqual(Charts.allowedDatasets('overview'), ['Total', 'Blocked', 'Cached', 'Recursive']);
            // The all view shows every counter the server sends.
            assert.deepEqual(Charts.allowedDatasets('all'), Object.keys(Charts.DATASET_COLORS));
        });
    });

    test.describe('RTT overlay', () => {
        test.it('lines the mean RTT up with the minutes of the chart', () => {
            const labels = ['2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', '2026-01-01T00:02:00Z'];

            const rtt = Charts.rttForLabels(labels, [
                { t: '2026-01-01T00:00:00Z', mean: 12.5 },
                { t: '2026-01-01T00:02:00Z', mean: 18.25 },
            ]);

            // The minute the server did not report has no value of its own.
            assert.deepEqual(rtt.data, [12.5, null, 18.25]);
            assert.equal(rtt.hasRtt, true);
        });

        test.it('has nothing to draw when the server sent no RTT', () => {
            const labels = ['2026-01-01T00:00:00Z'];

            assert.deepEqual(Charts.rttForLabels(labels, []), { data: [], hasRtt: false });
            assert.deepEqual(Charts.rttForLabels(labels, null), { data: [], hasRtt: false });
            // A series that matches none of the minutes has nothing to draw either.
            assert.deepEqual(Charts.rttForLabels(labels, [{ t: '2025-12-31T23:59:00Z', mean: 9 }]), { data: [null], hasRtt: false });
        });
    });
});
