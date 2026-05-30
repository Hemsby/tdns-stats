# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

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
