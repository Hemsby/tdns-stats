// Tests for backend/tests/helpers/technitium-data-gen.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTechnitiumData, trafficCurve, TRACKING_DOMAINS } = require('../helpers/technitium-data-gen');

// What the server really sends: the response type says where the answer came
// from and the response code says how it went.
const RESPONSE_TYPES = ['Authoritative', 'Recursive', 'Cached', 'Blocked', 'Dropped'];
const RESPONSE_CODES = ['NoError', 'NxDomain', 'ServerFailure', 'Refused'];

test.describe('backend/tests/helpers/technitium-data-gen.js', () => {
    test.describe('chart data', () => {
        test.it('counts the queries the chart drew', () => {
            const data = buildTechnitiumData({ seed: 1 });
            const datasets = data.dashboard.mainChartData.datasets;
            const total = datasets.find(d => d.label === 'Total');
            const noError = datasets.find(d => d.label === 'No Error');

            assert.equal(
                data.dashboard.stats.totalQueries,
                total.data.reduce((a, b) => a + b, 0),
            );
            // Every query ends in exactly one outcome.
            assert.ok(data.dashboard.stats.totalNoError <= data.dashboard.stats.totalQueries);
            assert.equal(noError.data.length, total.data.length);

            // The legend of the dashboard reads in this order, so the mock has
            // to answer in it too.
            assert.deepEqual(
                datasets.map(dataset => dataset.label),
                [
                    'Total',
                    'No Error',
                    'Server Failure',
                    'NX Domain',
                    'Refused',
                    'Authoritative',
                    'Recursive',
                    'Cached',
                    'Blocked',
                    'Dropped',
                    'Clients',
                ],
            );
        });

        test.it('answers every minute of the range it was asked for', () => {
            const data = buildTechnitiumData({ seed: 1, minutes: 45 });

            assert.equal(data.dashboard.mainChartData.labels.length, 45);
            for (const dataset of data.dashboard.mainChartData.datasets) {
                assert.equal(dataset.data.length, 45);
                for (const value of dataset.data) assert.equal(typeof value, 'number');
            }
        });
    });

    test.describe('top lists', () => {
        test.it('names every domain, client and blocked name it counts', () => {
            const data = buildTechnitiumData({ seed: 1 });

            for (const list of [data.topStats.TopDomains.topDomains, data.topStats.TopBlockedDomains.topBlockedDomains]) {
                for (const row of list) {
                    assert.ok(row.name, 'a row has no name');
                    assert.ok(row.hits > 0, `${row.name} has no hits`);
                }
            }
            for (const row of data.topStats.TopClients.topClients) {
                assert.ok(row.name, 'a client has no name');
                assert.ok(row.hits > 0);
            }
        });

        test.it('makes the names that are popular in the list the ones in the log', () => {
            const data = buildTechnitiumData({ seed: 5 });
            const counted = new Map();
            for (const entry of data.logEntries()) {
                if (TRACKING_DOMAINS.includes(entry.qname)) continue;
                counted.set(entry.qname, (counted.get(entry.qname) || 0) + 1);
            }
            const inLog = [...counted.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([name]) => name);
            const inList = data.topStats.TopDomains.topDomains.slice(0, 3).map(row => row.name);

            assert.deepEqual(inLog, inList);
        });
    });

    test.describe('query log', () => {
        test.it('gives every row the fields the feed reads', () => {
            const data = buildTechnitiumData({ seed: 1 });
            const rows = data.logEntries();

            assert.ok(rows.length > 0);
            for (const row of rows) {
                assert.ok(row.timestamp, 'a row has no timestamp');
                assert.ok(row.clientIpAddress, 'a row has no client');
                assert.ok(row.qname, 'a row has no name');
                assert.ok(row.qtype, 'a row has no type');
                assert.ok(row.responseType, 'a row has no response type');
                assert.ok(row.rcode, 'a row has no rcode');

                // A query that simply worked is NoError, which is a response
                // code. The response type says where the answer came from.
                assert.ok(RESPONSE_TYPES.includes(row.responseType), `${row.responseType} is not a response type`);
                assert.ok(RESPONSE_CODES.includes(row.rcode), `${row.rcode} is not a response code`);

                // A query the server refused never left it, so it has no time.
                const answered = (row.responseType === 'Recursive' || row.responseType === 'Cached') && row.rcode !== 'Refused';
                if (answered) {
                    assert.equal(typeof row.responseRtt, 'number');
                } else {
                    assert.equal(row.responseRtt, undefined);
                }
            }
        });

        test.it('numbers the rows so they only go up', () => {
            const data = buildTechnitiumData({ seed: 1 });
            const first = data.logEntries();
            const second = data.logEntries();

            // The rows of one log are numbered newest first, and the numbers
            // keep going up, so the feed can tell a new row from one it has
            // already shown.
            for (let i = 1; i < first.length; i++) {
                assert.ok(first[i].rowNumber < first[i - 1].rowNumber, 'the rows are numbered out of order');
            }
            assert.ok(second[0].rowNumber > first[0].rowNumber, 'the row numbers went backwards');
        });
    });

    test.describe('blocked names and the cache', () => {
        test.it('answers a blocked name with the lists that blocked it', () => {
            const data = buildTechnitiumData({ seed: 1 });

            // The report of every list that matched comes back as a TXT record.
            const txt = data.resolve({ domain: 'ads.doubleclick.net', type: 'TXT' });
            assert.ok(txt.result.Answer.length > 0);
            assert.equal(txt.result.Answer[0].Type, 'TXT');
            assert.match(txt.result.Answer[0].RDATA.CharacterStrings[0], /source=(block-list-zone|advanced-blocking-app)/);
            assert.match(txt.result.Answer[0].RDATA.CharacterStrings[0], /blockListUrl=/);

            // The answer to an address query is the datagram the server sent.
            const clean = data.resolve({ domain: 'www.wikipedia.org', type: 'A' });
            assert.equal(clean.result.Question[0].Name, 'www.wikipedia.org');
            assert.equal(clean.result.Answer.length, 1);
            assert.equal(clean.result.Answer[0].Type, 'A');
            assert.ok(clean.result.Answer[0].RDATA.IPAddress);
            assert.deepEqual(clean.result.Authority, []);
            assert.deepEqual(clean.rawResponses, []);
        });

        test.it('caches the names it answered for', () => {
            const data = buildTechnitiumData({ seed: 1 });
            const names = Object.keys(data.cache.names);

            assert.ok(names.length > 0);
            for (const [name, records] of Object.entries(data.cache.names)) {
                assert.ok(records.length > 0, `${name} has no record`);
                for (const record of records) {
                    assert.equal(record.name, name, 'a record is filed under the wrong name');
                    assert.ok(record.type, 'a record has no type');
                    assert.ok(record.rData, 'a record has no data');
                }
            }
        });
    });

    test.describe('patterns', () => {
        test.it('is busier in the working day than in the small hours', () => {
            const working = trafficCurve(new Date(Date.UTC(2026, 10, 11, 14, 0)));
            const night = trafficCurve(new Date(Date.UTC(2026, 10, 11, 3, 0)));

            assert.ok(working > night * 5, `${working} is not much busier than ${night}`);
        });

        test.it('answers in a range with a tail, and counts the same mix as the chart', () => {
            const data = buildTechnitiumData({ seed: 5, minutes: 120 });
            const totals = data.dashboard.mainChartData.datasets.find(d => d.label === 'Total').data;

            // A quiet node can answer the same number twice, but the volume
            // must move instead of running round in a short pattern.
            assert.ok(new Set(totals).size > 20, 'the volume repeats itself');
            assert.ok(Math.max(...totals) > Math.min(...totals), 'the volume never changes');

            const rtts = data
                .logEntries()
                .filter(e => e.responseRtt)
                .map(e => e.responseRtt)
                .sort((a, b) => a - b);
            const at = q => rtts[Math.floor(rtts.length * q)];

            assert.ok(at(0.95) > at(0.5) * 2, 'the slow answers are not a tail');
            assert.ok(at(0.5) > 0);

            // The share of blocked queries is the same on the chart and in the log.
            const entries = data.logEntries();
            const share = entries.filter(e => e.responseType === 'Blocked').length / entries.length;
            const fromChart = data.dashboard.stats.totalBlocked / data.dashboard.stats.totalQueries;

            assert.ok(Math.abs(share - fromChart) < 0.05, `${share} and ${fromChart} are not the same share`);
        });
    });

    test.describe('seed', () => {
        test.it('gives the same numbers for the same seed', () => {
            const first = buildTechnitiumData({ seed: 42 });
            const second = buildTechnitiumData({ seed: 42 });

            assert.deepEqual(first.dashboard.stats, second.dashboard.stats);
            assert.deepEqual(first.topStats.TopDomains, second.topStats.TopDomains);
        });

        test.it('gives different numbers for a different seed', () => {
            const first = buildTechnitiumData({ seed: 1 });
            const second = buildTechnitiumData({ seed: 2 });

            assert.notDeepEqual(first.dashboard.stats, second.dashboard.stats);
        });
    });
});
