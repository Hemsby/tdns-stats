# Count lists cap implementation test

Companion sidebar to [cap-test-data.md](cap-test-data.md). This report covers the range and top-N capping after it was wired into the real `collectBlockedLog` / `summarizeBlockedLog` path.

## Final setting

- Fixed **LastHour** (rolling 1 hour).
- Page size 1K, **20 pages** and **top 1,000 names per server**.
- Names are deduplicated by normalized qname per server, ranked by blocked-hit count descending, ties alphabetical, then capped.
- Truncation and name-cap exclusions are reported to the UI.

### Original page limit

Before any changes, `listBlockedQueries` fetched up to **20 pages x 1,000 entries = 20,000 entries per server**, counted _before_ loopback filtering. With two servers that was up to ~40,000 entries, which is why live totals previously exceeded 20,000.

## Synthetic low / moderate / high / stress — actual path

Conditions: one mock server per bucket, 5% loopback entries, 20 ms log delay, 1 ms TXT delay, page size 1,000. Totals are end-to-end `summarizeBlockedLog` wall times; discovery is excluded.

| Bucket   | Blocked | Distinct | Looked up | Skipped (names / hits) |     Pages |   Cold total | Cached total |
| -------- | ------: | -------: | --------: | ---------------------: | --------: | -----------: | -----------: |
| Low      |     100 |       12 |        12 |                  0 / 0 |       1/1 |    **50 ms** |    **23 ms** |
| Moderate |   2,000 |      150 |       150 |                  0 / 0 |       3/3 |   **213 ms** |    **71 ms** |
| High     |  10,000 |      500 |       500 |                  0 / 0 |     11/11 |   **667 ms** |   **271 ms** |
| Stress   |  60,000 |    5,000 |     1,000 |          2,890 / 2,890 | **20/63** | **1,165 ms** |   **498 ms** |

Low through high do not truncate or hit the name cap. Stress truncates at 20/63 pages (20,000 of 63,000 entries scanned, 3,890 distinct names seen) and caps 2,890 names / 2,890 hits.

## Live probe — actual path

Both servers (ns1 + ns2), page size 1,000, fixed LastHour window.

| Scope | Pass |    Wall | Blocked | Loopback | Distinct | Lookups | Cache hits | Pages | Entries | Truncated |
| ----- | ---- | ------: | ------: | -------: | -------: | ------: | ---------: | ----: | ------: | --------- |
| all   | cold | 0.155 s |   1,277 |    2,166 |       57 |      77 |          0 |   4/4 |   3,443 | no        |
| all   | warm | 0.126 s |   1,277 |    2,243 |       57 |       0 |         77 |   4/4 |   3,520 | no        |
| ns1   | cold | 0.147 s |     705 |    1,884 |       55 |      55 |          0 |   3/3 |   2,589 | no        |
| ns1   | warm | 0.085 s |     705 |    1,939 |       55 |       0 |         55 |   3/3 |   2,644 | no        |
| ns2   | cold | 0.046 s |     572 |      359 |       22 |      22 |          0 |   1/1 |     931 | no        |
| ns2   | warm | 0.026 s |     572 |      381 |       22 |       0 |         22 |   1/1 |     953 | no        |

Live traffic uses 3 and 1 pages and well under 1,000 names, so the fixed limits do not truncate current traffic.

## Key results

- LastHour high: **667 ms cold / 271 ms cached**, 11/11 pages, no truncation.
- LastHour stress: **1,165 ms cold / 498 ms cached**, truncated at 20/63 pages, name cap skips 2,890 names / 2,890 hits.
- Warm passes are 100% cached because 1,000 names fit under the 2,000-entry block-report cache.
- Live LastHour finishes in **3 and 1 pages** with **55 and 22 names**, far inside the 20-page / 1,000-name limits.
- Fresh cold/warm run: **0.155 s / 0.126 s** for all servers, **0.147 s / 0.085 s** for ns1, **0.046 s / 0.026 s** for ns2.
- The UI notes only appear when the caps bind: more than 20 pages or more than 1,000 distinct names in the hour.

## UI note callout

The bottom note in the **Block list totals** card shows the lookup count first, then a second line for any limit notes:

- `Showing newest 20,000 blocked entries (20 of 63 pages).` when the page limit truncates.
- `Top 1,000 names by hits; 2,890 names / 2,890 hits excluded.` when the name cap skips names.
