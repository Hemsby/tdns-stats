# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

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
