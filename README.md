# tdns-stats

A self-hosted statistics dashboard for [Technitium DNS Server](https://technitium.com/dns/) v15 and later.

Displays live query feeds, per-server and cluster stats, top domains/clients, performance metrics (RTT, cache hit rate), and a real-time chart — all pushed to the browser via Server-Sent Events with no page refreshes required.

## Requirements

- Node.js 18 or later
- Technitium DNS Server v15 or later
- A query log app installed on each DNS server (e.g. Query Logs SQLite, MySQL, PostgreSQL) if you want the live feed and RTT metrics

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/Hemsby/tdns-stats.git
cd tdns-stats
```

### 2. Install dependencies

```bash
cd backend
npm install
cd ..
```

### 3. Configure

```bash
cp config.example.yml config.yml
```

Edit `config.yml` and fill in your server details. At minimum you need the `name`, `url`, and `token` for each server. See `config.example.yml` for all available options with descriptions.

To get your API token: open the Technitium web UI, go to **Settings > API Keys**, and create a token with at least read access.

### 4. Run

```bash
node backend/src/server.js
```

Then open `http://your-host:3000` in a browser.

## Running as a systemd service

Create `/etc/systemd/system/tdns-stats.service`:

```ini
[Unit]
Description=Technitium DNS Statistics Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/tdns-stats
ExecStart=/usr/bin/node /opt/tdns-stats/backend/src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then enable and start it:

```bash
systemctl daemon-reload
systemctl enable tdns-stats
systemctl start tdns-stats
```

## Configuration reference

All configuration lives in `config.yml` (see `config.example.yml` for a fully annotated example).

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `3000` | Port the web interface listens on |
| `servers[].name` | required | Display name for the server |
| `servers[].url` | required | Technitium API base URL (e.g. `http://ns1.example.com:5380`) |
| `servers[].token` | required | API token |
| `servers[].ignoreSsl` | `false` | Skip TLS certificate verification |
| `servers[].queryLogsApp` | auto-detect | Name of the query log app on this server |
| `servers[].color` | auto-assigned | Colour for this server in the UI |
| `poll.statsInterval` | `10` | Seconds between stats refreshes |
| `poll.feedInterval` | `3` | Seconds between live feed polls |
| `poll.topInterval` | `30` | Seconds between top-list refreshes |
| `poll.perfInterval` | `30` | Seconds between RTT/cache samples |
| `feed.pageSize` | `20` | Log entries fetched per poll cycle |
| `feed.maxEntries` | `200` | Maximum entries kept in the browser feed |
| `top.limit` | `20` | Number of items in top domains/clients lists |
| `rtt.sampleSize` | `500` | Log entries scanned per RTT sample |

### Server colours

Available values for `servers[].color`: `blue`, `green`, `ora`, `teal`, `pur`, `yel`, `red`.

If `color` is omitted, servers are auto-assigned colours by their position in the list.

### HTTPS

To serve over HTTPS without a reverse proxy, add an `https` block to `config.yml`:

```yaml
https:
  cert: /etc/ssl/certs/tdns-stats.crt
  key:  /etc/ssl/private/tdns-stats.key
```

Or using a single combined PEM file (certificate and private key in one file):

```yaml
https:
  pem: /etc/ssl/private/tdns-stats-combined.pem
```

### Cluster support

If your Technitium servers are configured as a cluster, the dashboard automatically detects this and adds a **Cluster** tab showing aggregate stats across all nodes alongside the per-node view.

## Live feed

The live feed requires a query log app to be installed on each DNS server. Supported apps include:

- Query Logs (SQLite)
- Query Logs (MySQL)
- Query Logs (PostgreSQL)
- Query Logs (SQL Server)

If you have more than one query log app installed, specify which one to use with `servers[].queryLogsApp`. Otherwise the first one found is used automatically.

## Themes

The dashboard supports light, dark, and system themes. The preference is stored in the browser and applied on next load with no flash of unstyled content.
