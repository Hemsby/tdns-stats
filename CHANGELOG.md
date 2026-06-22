# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [2.2.1] - 2026-06-22

### Fixed

- SSE connection handler no longer accumulates orphaned connections in memory after unexpected disconnects, preventing server memory use from growing unboundedly over time.
- Cache & Blocked tab domain search now validates input against RFC 1035 label constraints (max 253 octets, labels ≤63 octets, no leading/trailing/consecutive dots, no leading/trailing hyphens, at least one dot required) and performs checks on the raw input before normalization strips dot characters, ensuring malformed domains are rejected rather than silently sanitised.

## [2.2.0] - 2026-06-22

### Changed

- Perf card now derives its RTT sample size dynamically from the last hour's total recursive query count instead of a fixed config value - scales automatically with traffic, capped at the last 500 queries (freshest data for both low/high volume servers).
- Perf card now shows "waiting for data..." when no recursive queries are available to compute metrics instead of "collecting samples...".
- Perf card no longer displays the "X recursive samples" badge in the card header.
- Deprecated `rtt.sampleSize` configuration option - this is no longer required.

### Fixed

- Dashboard no longer freezes after extended idle periods - all time range data (LastDay - LastYear) now correctly reaches the frontend regardless of which tab or chart option is selected.
- Query Chart and Top Stats now show fresh data immediately on tab return after being backgrounded, SSE reconnect, or server restart instead of displaying stale cached data.

## [2.1.2] - 2026-06-17

### Changed

- Hide server selection dropdown on Cache & Blocked tab when only a single server is available.

## [2.1.1] - 2026-06-17

### Fixed

- Cache & Blocked tab was broken after previous Navbar changes.

## [2.1.0] - 2026-06-17

### Added

- Top Stats card now defaults to "Follow chart" on aggregate (Cluster / All servers) tabs, showing data for the same server selected in the Query Chart.

### Changed

- Server selection dropdowns (Chart, Top Stats, Feed) are now hidden on individual server/node tabs since they are not applicable.
- Navbar (topbar and server tabs) now properly stays fixed at the top of the page when scrolling on desktop.

### Fixed

- Live feed no longer clears valid entries when a server's query log rowNumber counter drifts backward - cursor comparison now uses timestamps instead of rowNumbers, eliminating false log rotation detections.
- Live feed entries from different servers are now correctly ordered by timestamp instead of by arrival order.

## [2.0.5] - 2026-06-17

### Changed

- Perf card now displays cache Hit Rate, Miss Rate, and Population immediately from dashboard stats, without waiting for RTT samples to arrive.
- All time range data (including LastDay, LastWeek, LastMonth, LastYear) is now continuously pushed via SSE from a background server-side poller, eliminating HTTP fetch requests from the browser entirely.
- All ranges now use only native Technitium API range types instead of the Custom range type. This prevents the NRE scenario entirely as the only trigger path is now completely removed.

### Fixed

- Live feed no longer potentially shows duplicate (past) entries when returning from a backgrounded tab - entries are de-duplicated before entering the display queue and are kept in correct arrival order.

## [2.0.4] - 2026-06-12

### Changed

- Last Day chart and Top Stats data is now pushed from the server instead of being polled by the browser. This prevents the NRE crash more reliably - the fix no longer relies on a browser timer that can drift or be throttled when the tab is backgrounded.

## [2.0.3] - 2026-06-12

### Changed

- Minor UI tweaks to improve consistency (button hover states, font sizing in Top Stats card).

## [2.0.2] - 2026-06-11

### Fixed

- Fixed a crash in Technitium DNS Server that would permanently stop all statistics from being saved when using the "Last Day" time range in the Query Chart for an extended period. The crash occurred when tdns-stats happened to read hourly statistics at the exact same moment the Technitium server was writing them, resulting in a `NullReferenceException` that disabled stats tracking until the server was manually restarted.

## [2.0.1] - 2026-06-10

### Changed

- Updated Theme Selector to show current selected theme, and a dropdown to change theme (reducing space required)
- Update check icon enlarged to match Theme Selector icon size.
- Improved console logging to help with any update errors.

## [2.0.0] - 2026-06-10

### Changed

**IMPORTANT:** This major release contains a breaking change related to Docker deployments (see below).

- Docker deployments **must** be manually updated, you should first back up your `config.yml` file
  and then follow the updated instructions in the [README](https://github.com/Hemsby/tdns-stats/blob/master/README.md) under the
  [Running with Docker](https://github.com/Hemsby/tdns-stats#running-with-docker) section to redeploy. This is required to fix multiple issues regarding
  Docker Compose deployments and the built-in update functionality. **NOTE:** Deployments via systemd
  service are not affected by this issue, and users do not need to take any action.
- Hide update functionality in UI for plain Docker deployments (This functionality is only available when deployed
  via Docker Compose or as a systemd service).

### Removed

- Built-in update functionality for bare-metal/development/manual `git clone` local deployments has been removed
  (this functionality never fully worked for this type of deployment anyway).

## [1.8.1] - 2026-06-09

### Fixed

- Fixed an issue where Changelog pop-up modal could not properly load the CHANGELOG.md file for users running via Docker deployment.
- Preserve user changes to `docker-compose.yml` file such as (custom port mappings, environment variables and mount points) when updating through the dashboard when deployed via Docker.

## [1.8.0] - 2026-06-08

### Added

- Added Changelog pop-up modal that opens when the current version pill is clicked, showing release history.

## [1.7.8] - 2026-06-08

### Fixed

- Restored accidentally removed style class for live feed timestamps.

## [1.7.7] - 2026-06-08

### Fixed

- Corrected Stat Cards colours (They got overridden on a previous patch update).
- Refused queries now shown correctly in live feed. They were previously masked by Authoritative queries.
- Removed Dropped and No Error from live feed filters as they individually are not required.

## [1.7.6] - 2026-06-08

### Fixed

- All time ranges now properly include all data for the given range (fixed the issue where some ranges (LastDay, LastYear) were off-by-one or otherwise not correctly including all data).
- Ensure chart periodic labels accurately reflect the data displayed for the selected time range.

## [1.7.5] - 2026-06-07

### Added

- Added connected users as Viewers on Dashboard

### Fixed

- Small tidy of code and timers functions
- Slight size increase of Check for Updates button

## [1.7.4] - 2026-06-07

### Fixed

- Docker Updates should now complete correctly.

## [1.7.3] - 2026-06-07

### Changed

- Fetch Query Chart and Top Stats immediately on page load when any time range is selected, so data appears without waiting for the first polling interval.
- Refresh both Query Chart and Top Stats every 60s for the 'Last Day' (hourly data) time range.

### Fixed

- Prevent periodic top-stats polling data (always LastHour) from overwriting the Top Stats card when another time range is selected.

## [1.7.2] - 2026-06-06

### Fixed

- Docker failing to Update due to hardcoded bin/bash in updater.js

## [1.7.1] - 2026-06-06

### Fixed

- Removed the temporary console debug options left behind from Develop

## [1.7.0] - 2026-06-06

### Added

- **Cache & Block Test:** Added a new page tab for quickly checking cache and performing a block test on domain names.

## [1.6.2] - 2026-06-04

### Changed

- **Improved Jitter Accuracy:** Replaced the simplistic "statistical skew" method with a standard RFC 3550 EWMA algorithm. This provides a much more accurate and stable health metric for DNS upstream performance by measuring actual inter-arrival delay variation.

## [1.6.1] - 2026-06-03

### Fixed

- **SSE Stability Hardening:** Fixed rapid "connected/connecting" glitch loop by implementing a 2-second connection cooldown and explicit timer cleanup in the frontend.
- **Backend Robustness:** Added formal JSON `ping` events and explicit SSE `error` listeners to prevent the backend process from crashing on write errors (e.g., due to SSL issues or abrupt disconnects).
- **Auto-Reconnect Instruction:** Added `retry: 5000` header to inform browsers to wait longer between native reconnection attempts.

## [1.6.0] - 2026-06-03

### Changed

- Improved consistency of numerical output by hiding unnecessary decimal precision on whole numbers.
- Refined live feed to hide latency for instant query types like Cached or Blocked.

### Fixed

- Resolved UI glitching during reconnection by ensuring only one recovery path is active after a restart.

## [1.5.1] - 2026-06-02

### Fixed

- **NX Domain Visibility:** Fixed logic where resolution method (Recursive/Authoritative) was masking the NXDOMAIN error status in the live feed badges.
- **Filter Accuracy:** Updated live feed filters to correctly identify NXDOMAIN and Server Failure queries using RCODE data.
- **Visual Consistency:** Ensured orange and red markers appear for all error types, not just blocked queries.
- **Code Cleanup:** Removed temporary debug logs and test-specific diagnostics.

## [1.5.0] - 2026-06-02

### Added

- **Live Latency (ms):** Added a new column to the live feed showing round-trip time (RTT) for recursive queries.
- **Query Type:** Added query type (A, AAAA, TXT, etc.) to the live feed for better visibility.
- **Vibrant UI:** Completely overhauled the color palette for high-contrast Red and Orange distinctions.

### Changed

- **Color Synchronization:** Synchronized colors across graph legends, stats cards, and feed badges (Authoritative=Yellow, NXDOMAIN=Orange, Failure=Red).
- **Layout Optimization:** Tightened feed columns to give significantly more room for domain names.
- **Top Stats:** Renamed "TOP" card to "TOP STATS" and fixed alignment of hostnames in the Clients tab.
- **Streamlined Stats:** Removed redundant text-based "Block %" figures in favor of the visual bar for a cleaner look.

### Fixed

- Fixed hostname truncation and right-alignment issues in the Top Clients list.

## [1.4.1] - 2026-05-31

### Fixed

- Update process now waits for service to fully restart (detected via started_at timestamp) instead of guessing delays
- Browser cache cleared on successful update to ensure fresh JavaScript and CSS load

## [1.4.0] - 2026-05-31

### Added

- Live feed multi-select response type filters with per-server persistence
- All/None quick selection buttons for feed filters
- Cluster nodes table with last synced timestamp and node URL links
- Smart reconnection countdown timer instead of silent wait
- Extended statistics display (Recursive, Authoritative, Refused, Dropped queries)

## [1.3.0] - 2026-05-30

### Added

- Dynamic chart heading that updates based on selected time range (Queries per minute/hour/day)
- Recursive dataset added to Overview graph for better query type visibility

## [1.2.1] - 2026-05-30

### Fixed

- Fixed auto-update not executing due to missing shell context in git and systemctl commands
- Improved error logging in update process for better troubleshooting

## [1.2.0] - 2026-05-30

### Added

- Chart legend click interactions to hide/show individual datasets
- Persist hidden chart dataset preferences to localStorage so selections survive page reloads
- Independent hidden state tracking per chart view mode (Overview vs All datasets)

## [1.1.0] - 2026-05-29

### Added

- Auto-update feature with a check-for-updates button and one-click update trigger in the UI
- Version number displayed in the UI
- Auto-update support for git clone, Docker, and systemd deployments
- Automatic service recovery detection after an update
- Performance data caching so newly connected clients receive instant dashboard population
- Smart polling that pauses when no clients are connected and resumes on reconnect
- Auto-reconnect SSE when the connection silently stalls
- Feed stall detection with a warning banner when the live feed has been silent for more than 2 minutes
- Standalone badge on server cards for non-cluster nodes
- Case-insensitive matching for `queryLogsApp` name

### Fixed

- Corrected cache impact (RTT effect) calculation which was producing inflated values due to incorrect inputs; it now considers only recursive queries with a valid upstream RTT (#4 - thanks @sjclayton)
- Fixed RTT sample size being ignored because the Technitium DNS Logs API uses `entriesPerPage` not `limit`, causing results to silently fall back to the API default of 25 (#1 - thanks @sjclayton)
- Fixed `ignoreSsl: true` incorrectly creating an HTTPS agent for plain HTTP URLs, which caused the query log app to go undiscovered
- Fixed feed cursor sticking when the query log was reset or rotated
- Fixed concurrent feed polls producing duplicate entries
- Fixed stat value text overflowing in narrow grid cells

## [1.0.0] - 2026-05-26

### Added

- Initial release
