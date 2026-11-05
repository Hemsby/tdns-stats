# Count lists performance test data

Live testing performed against the backend (v2.5.0) and my live Technitium servers on 2026-11-05.

## Test plan

1. Measure against the live instance running on `localhost:3000` with two real Technitium servers.
2. Reuse the same blocked-log filtering plus `listsForDomain()` TXT path, adding Technitium's standard `start`/`end` log filters for `LastHour` and `LastDay`.
3. Run controlled low / moderate / high traffic buckets through a mock Technitium API using the real log-entry and TXT-response shapes.
4. Measure both a cold check (TXT lookup required) and an immediate second click (cache reuse).

## How the cost works

- Count lists already deduplicates per server: one TXT lookup per distinct non-loopback blocked name.
- **TXT requests = sum over servers of distinct blocked names − cache hits.**
- The same name on two servers produces two TXT requests, because the block-report cache key includes the server.
- Check total = log page fetches + TXT lookup phase + discovery. Servers are processed sequentially; TXT lookups run 4 at a time per server.
- Current code caps at 20 pages × 1,000 entries per server (`backend/src/technitium.js:723`).

## Cache isolation

- The only live tests against `localhost:3000` were the two whole-log Count lists clicks:
  - First click: `lookups=819`, `cacheHits=0` - genuinely cold.
  - Second click: `lookups=0`, `cacheHits=817` - deliberately warm.
- The synthetic low/moderate/high tests also used a fresh process per range, so their cold rows are cold and their cached rows are second passes only.

## LastHour — controlled synthetic

One server per bucket, 5% loopback entries, realistic Technitium log/TXT payloads.

| Traffic bucket | Blocked queries | Distinct names = TXT requests | Uncached TXT phase             | Uncached check total | Cached TXT phase        | Cached check total |
| -------------- | --------------: | ----------------------------: | ------------------------------ | -------------------: | ----------------------- | -----------------: |
| Low            |             100 |                            12 | 12 req · 14 ms · 1.17 ms/req   |            **76 ms** | 0 req · 12 hits · 0 ms  |          **34 ms** |
| Moderate       |           2,000 |                           150 | 150 req · 106 ms · 0.71 ms/req |           **186 ms** | 0 req · 150 hits · 1 ms |          **73 ms** |
| High           |          10,000 |                           500 | 500 req · 363 ms · 0.73 ms/req |           **671 ms** | 0 req · 500 hits · 1 ms |         **272 ms** |

## LastDay — controlled synthetic, full 24 hours

| Traffic bucket | Blocked queries | Distinct names = TXT requests | Uncached TXT phase                 | Uncached check total | Cached TXT phase              | Cached check total |
| -------------- | --------------: | ----------------------------: | ---------------------------------- | -------------------: | ----------------------------- | -----------------: |
| Low            |             600 |                            50 | 50 req · 42 ms · 0.84 ms/req       |           **106 ms** | 0 req · 50 hits · 0 ms        |          **35 ms** |
| Moderate       |          15,000 |                           700 | 700 req · 478 ms · 0.68 ms/req     |           **910 ms** | 0 req · 700 hits · 3 ms       |         **395 ms** |
| High           |          60,000 |                         5,000 | 5,000 req · 3,031 ms · 0.61 ms/req |         **4,665 ms** | 5,000 req · 0 hits · 3,147 ms |       **4,709 ms** |

For the high LastDay row, caching gives **no benefit**. The block-report cache is capped at 2,000 entries (`backend/src/technitium.js:559-573`); with 5,000 names, a sequential second scan evicts entries before reaching them, so every TXT is sent again.

### Current 20-page cap impact at high LastDay volume

| Entries scanned  | Blocked counted | Distinct names | Uncached total | Cached total | Result                                                             |
| ---------------- | --------------: | -------------: | -------------: | -----------: | ------------------------------------------------------------------ |
| 20,000 of 63,000 |          19,048 |          3,890 |       3,006 ms |     2,855 ms | `truncated: true`; misses ~1,110 names and ~41,000 blocked queries |

So a range-limited implementation must also remove or raise the 20-page cap, or it will silently undercount high-volume LastDay.

## Live validation — `localhost:3000`, real ns1 + ns2

Observed 2026-11-05 around 08:26 EST. LastHour was low-volume and volatile; an earlier run showed 488 blocked / 45 names.

| Range    | Blocked, non-loopback | Distinct names, union | TXT requests, per server | Uncached fetch | Uncached TXT         | Uncached total | Cached TXT       | Cached total |
| -------- | --------------------: | --------------------: | -----------------------: | -------------: | -------------------- | -------------: | ---------------- | -----------: |
| LastHour |                   210 |                    11 |                       11 |          87 ms | 20 ms · 1.8 ms/req   |     **120 ms** | 0 req · 11 hits  |   **301 ms** |
| LastDay  |                13,966 |                   486 |                      560 |         424 ms | 268 ms · 0.48 ms/req |     **703 ms** | 0 req · 560 hits |   **717 ms** |

Live comparison for the current whole-log Count lists:

| Click  | Blocked queries | Distinct names | TXT requests | Cache hits |        Time |
| ------ | --------------: | -------------: | -----------: | ---------: | ----------: |
| First  |          32,499 |            819 |          819 |          0 | **1.039 s** |
| Second |          31,514 |            817 |            0 |        817 | **0.378 s** |

## Findings

- Count lists cost is driven by **distinct blocked names**, not blocked query volume. Low vs high LastHour was 12 vs 500 TXT requests; low vs high LastDay was 50 vs 5,000.
- LastHour is cheap even at 10,000 blocked queries/hour: **671 ms cold / 272 ms warm**, 500 TXT requests.
- LastDay is the expensive range. At 60,000 blocked queries/day: **4.67 s cold**, with TXT lookups taking 3.0 s and log fetching 1.6 s.
- Caching works well up to roughly 2,000 names: second clicks send **0 TXT** and the lookup phase is near zero. Above that, the 2,000-entry cache thrashes and a second click repeats every TXT.
- The feature's own TXT lookups appear in the query log as loopback and are correctly skipped, but they still inflate the next click's log read volume.
- The shipped whole-log Count lists does **not** support LastHour/LastDay. Adding range support is straightforward via the query-log API's `start`/`end`, but the 20-page cap and 2,000-entry cache both need adjustment considerations for high-volume servers.
