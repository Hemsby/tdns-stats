# Tests

Run everything from the project root:

```sh
npm test
```

That runs production tests, then mock tests. Either half can run on its own:

```sh
npm run test:production   # code the dashboard is made of
npm run test:mock         # mock Technitium that tests stand against
```

One file at a time — one group of tests for one source file:

```sh
node --test backend/tests/technitium.test.js
node --test backend/tests/blocklists.test.js
node --test backend/tests/poller.test.js
node --test backend/tests/server.test.js
node --test backend/tests/updater.test.js
node --test frontend/tests/app.test.js
node --test frontend/tests/blocklists.test.js
node --test frontend/tests/charts.test.js
node --test frontend/tests/feed.test.js
node --test frontend/tests/helpers.test.js
node --test frontend/tests/selection.test.js
```

Or one group inside a file:

```sh
node --test --test-name-pattern="report cache" backend/tests/blocklists.test.js
```

No test dependencies. Runner is Node's own (`node:test`), so there is nothing
to install and nothing to keep up to date.

## Where things live

Every test file covers one source file, and its name says which:

| Test file | Covers |
| --- | --- |
| `backend/tests/technitium.test.js` | `backend/src/technitium.js` |
| `backend/tests/blocklists.test.js` | `backend/src/blocklists.js` |
| `backend/tests/poller.test.js` | `backend/src/poller.js` |
| `backend/tests/server.test.js` | `backend/src/server.js` |
| `backend/tests/updater.test.js` | `backend/src/updater.js` |
| `frontend/tests/app.test.js` | `frontend/js/app.js` |
| `frontend/tests/blocklists.test.js` | `frontend/js/blocklists.js` |
| `frontend/tests/charts.test.js` | `frontend/js/charts.js` |
| `frontend/tests/feed.test.js` | `frontend/js/feed.js` |
| `frontend/tests/helpers.test.js` | `frontend/js/helpers.js` |
| `frontend/tests/selection.test.js` | `frontend/js/selection.js` |

Tests of the mock live in their own folder, `backend/tests/mock/`, so it is
always clear which tests say something about the dashboard and which say
something about the stand-in they test against:

| Test file | Covers |
| --- | --- |
| `backend/tests/mock/technitium-mock.test.js` | `backend/tests/helpers/technitium-mock.js` |
| `backend/tests/mock/technitium-data-gen.test.js` | `backend/tests/helpers/technitium-data-gen.js` |
| `backend/tests/mock/technitium-cluster-mock.test.js` | `backend/tests/helpers/technitium-cluster-mock.js` |

A test in `backend/tests/` is about production behaviour: it uses mock
Technitium only to stand in for a Technitium server, and asserts what the
dashboard does with what the server said. A test in `backend/tests/mock/` is
about mock Technitium itself: it asserts that mock answers the way a real
Technitium server answers, so tests that use it can trust it.

Inside a file, tests are grouped with `describe`, one group per area of that
file. The outer group names the source file, so a failing test says where it
came from without anyone having to look it up.

Helpers are shared by more than one file, so they live in
`backend/tests/helpers/`:

| Helper | What it gives you |
| --- | --- |
| `technitium-mock.js` | mock Technitium: a real HTTP server on an ephemeral port |
| `technitium-data-gen.js` | realistic Technitium data: stats, perf data, chart, top lists, query log, cache, DNS answers |
| `technitium-cluster-mock.js` | cluster of mock Technitium nodes that know each other |
| `app.js` | app with a mock poller and updater, plus a client for it |
| `poller-fixture.js` | mock Technitium module, plus a poller wired to it |
| `run-mock.js` | runs a mock Technitium by hand, for looking at the dashboard |

The frontend is ES modules. `frontend/package.json` says `{"type": "module"}`,
so the browser loads the files as modules and Node reads them the same way.

## The Technitium mocks

No real Technitium server exists to test against, so mocks stand in for one.
They are HTTP servers, not stubbed functions, so a test exercises transport as
well: `Authorization` header, status codes, JSON envelopes and retry path.

### One server

```js
const { createTechnitiumServer } = require('./helpers/technitium-mock');

const mock = await createTechnitiumServer().start();
t.after(() => mock.stop());

const dash = await getDashboard(mock.serverConfig('ns1'));
```

Without options mock Technitium answers like a real Technitium server: same
stats, same shapes, a query log that keeps growing. A test that needs only one
field passes just that field, and everything else stays realistic.

```js
const mock = await createTechnitiumServer({
    info: { version: '15.6.2', dnsServerDomain: 'ns1.home.arpa' },
    logEntries: [{ timestamp: '2026-01-01T00:00:00Z', rowNumber: 1 }],
}).start();
```

| Option | What it answers |
| --- | --- |
| `info` | `/api/user/session/get` |
| `settings` | `/api/settings/get` |
| `apps` | `/api/apps/list` |
| `dashboard` | `/api/dashboard/stats/get` |
| `topStats` | `/api/dashboard/stats/get`, by `statsType` |
| `logEntries` | `/api/logs/query`, an array or a function |
| `clusterState` | `/api/admin/cluster/state` |
| `cache` | `/api/cache/list`, as names the cache holds |
| `dnsClient` | `/api/dnsClient/resolve` |
| `resolve` | `/api/dnsClient/resolve`, as a function of the query |
| `cluster` | the nodes this server belongs to, as `() => [{ name, state }]` — a request for another node is answered with that node's data, and a request for the cluster with the totals of every node |

Two methods on mock Technitium exist for the tests themselves:

```js
mock.requests;              // every request, with its path, query and headers
mock.fail('/api/settings/get', 503);   // make the calls under a path fail
```

### The data

`technitium-data-gen.js` builds data, so it can be used without a server too.
It is generated from a seed, so the same seed always gives the same numbers,
and data is shaped the way a real Technitium server shapes it:

- **stats** are flat, the way the dashboard reads them
  (`node.stats.stats.totalQueries`);
- **chart** is `mainChartData` with a label per minute and a dataset per
  outcome;
- **top lists** are `topDomains`, `topBlockedDomains` and `topClients`,
  each row a `name` and a `hits` count;
- **query log** rows carry a timestamp, a client, a name, a type, a
  response type and an rcode, and answered ones a round trip time;
- **cache** holds names the node answered for, with records it kept for them,
  and `/api/cache/list` answers with records of the name that was asked for
  and zones under it, the way a real server does;- **a blocked name** answers with the block list that blocked it, in
  `extraText` and as a TXT record, and a clean name answers with a record.

Every node has a **profile** of its own, drawn from the seed: how much
traffic it carries, what that traffic is made of, when it is busy, how fast it
answers, and which names and clients ask for it. Two nodes of a cluster are
never alike, and a node built twice from the same seed always is. Cluster mock
gives every node a profile and spreads volumes between them, so no two nodes
carry the same amount of traffic.

```js
const { buildTechnitiumData, buildProfile, makeRandom } = require('./helpers/technitium-data-gen');

const data = buildTechnitiumData({ seed: 7 });          // a node with its own profile
const profile = buildProfile(makeRandom(7));             // profile on its own
```

Vocabulary is the one the server really uses, so the dashboard sees what
it would see in production:

| Field | Values |
| --- | --- |
| `responseType` | `Authoritative`, `Recursive`, `Cached`, `Blocked`, `Dropped` |
| `rcode` | `NoError`, `NxDomain`, `ServerFailure`, `Refused` |

A query that simply worked is `NoError`, which is a response **code** and not
a response **type**; response type says where the answer came from. The feed
shows response type, and response code takes over the badge for `NxDomain`,
`ServerFailure` or `Refused`.

### A cluster

```js
const { createTechnitiumCluster } = require('./helpers/technitium-cluster-mock');

const cluster = await createTechnitiumCluster({ seed: 1, count: 3 });
t.after(() => cluster.stop());

const servers = [0, 1, 2].map(index => cluster.serverConfig(index));
```

Every node runs its own server, the way a real cluster does, and each one
reports the others in `/api/admin/cluster/state`. First node is the primary,
the rest are secondaries, and a node sees itself as `Self` and the others as
`Connected`. Each node has its own profile, so nodes of a cluster carry
different traffic, answer it differently and are asked for different names.

### By hand

To look at the dashboard with data in it:

```sh
node backend/tests/helpers/run-mock.js
node backend/tests/helpers/run-mock.js --cluster 3 --seed 7
```

It prints a whole `config.yml` to paste in — every option the server reads,
with the mock servers filled in — then stays up until stopped.

### By hand, with a config file of its own

The server reads `/etc/tdns-stats/config.yml` first and the project
`config.yml` second. To leave those alone, give the server a config file of
its own on the command line:

```sh
node backend/src/server.js --config /tmp/mock-config.yml
```

`--config=path` works too. The file named has to exist, or the server refuses
to start. Every key in `config.example.yml` works in it, including `port`, so
a mock run can sit on its own port next to a real one:

```sh
node backend/tests/helpers/run-mock.js --cluster 3   # prints the config to save
node backend/src/server.js --config /tmp/mock-config.yml
```

## The rules

**A new Technitium API call** is one route in mock Technitium and one case in
the module's test file. The test runs against the real HTTP path, so it
exercises transport for free.

**A new backend feature** is a case in the test file of the module it lives
in, driven through that module's own interface.

**A new frontend feature** is a case in the test file of the module it lives
in.

**A feature that cannot be reached through an existing interface** needs a
seam first. The interface is the test surface, and that rule is what makes
"testable" a property of the codebase rather than of one feature.

Seams that exist today:

| Seam | How to use it |
| --- | --- |
| `technitium.js` — HTTP client | `__setFetch(fn)` swaps the transport |
| `technitium.js` — caches | `__resetState()` clears them between tests |
| `blocklists.js` — caches | `__resetState()` clears them between tests |
| `server.js` — config | `setConfig(cfg)` injects a config instead of reading the file |
| `server.js` — app | `createApp(poller, updater)` builds the routes without a listener |
| `poller.js` — Technitium module | fourth constructor argument replaces it |
| `updater.js` — shell | second constructor argument replaces `execAsync` |
| `updater.js` — filesystem | third constructor argument replaces `fs.existsSync`, so the answer does not depend on the machine a test runs on |
| `feed.js` — rows | `filterEntries(server, filters)` returns them without a DOM |
| `selection.js` — selection | `applyValue(...)` and `clearAll()` change it without a DOM |
| `selection.js` — decisions | `rangeSelection(...)`, `nextFocusIndex(...)` and `countSelected(...)` say what a click, a key press or a count does |
| `charts.js` — labels | `formatLabels(labels, fmt, tzOffset)` formats them without a DOM |
| `charts.js` — decisions | `allowedDatasets(mode)` and `rttForLabels(labels, series)` say which counters a view shows and where RTT lands |
| `app.js` — decisions | `serverNamesOf(...)`, `isClusterState(...)`, `defaultTabFor(...)`, `isAggregateTab(...)`, `effectiveTopServer(...)`, `queryLogStatusOf(...)`, `rangeCacheKey(...)` and `viewerCount(...)` say what a message means without a DOM |

## How to name a test

Name says what the behaviour is, in plain words. Group it sits in says which
function and which file it belongs to:

```js
test.describe('frontend/js/feed.js', () => {
    test.describe('rows', () => {
        test.it('keeps only the ones it has not seen before', () => { ... });
    });
});
```

**No name starts with "the".** Neither group nor case: `report cache`,
`cluster election`, `rows` — not `the report cache`, `the rows`. Section
headings in source files follow the same rule: `// ---- HTTP transport ----`,
never `// ---- The HTTP transport ----`.

## How many cases a group has

**A group covers one function or one route, and it gets exactly two cases: one
valid and one failing.** Valid one is the happy path; failing one is the
error, empty answer or wrong input.

```js
test.describe('report cache', () => {
    test.it('keeps a report for half an hour', () => { ... });        // valid
    test.it('asks again after the half hour is up', () => { ... });   // failing
});
```

A group covering two functions gets two cases **for each** of them, so four
in all, grouped by function. A group covering two different features is two
groups, each with its own two cases.

There is no third "and also" case. When one case has to say two things, it
says both:

```js
test.it('keeps a report for half an hour and an empty one for ten minutes', () => {
    // the report, the empty answer, and the lookups that were not made
});
```

## Never lose a case

When groups are rearranged, every case that was there before is still there. A
case is not deleted because its group changed shape; it moves, and if it needs
a new name it keeps saying the same thing.

## What to test

Behaviour that would hurt if it broke: feed cursor and dedup, percentiles,
cluster weighting, block list caps, session auth, transport, app discovery,
stream pausing, certificate fallback, cluster election, and shape of mock data
the dashboard reads.

Not behaviour that would not: a getter that returns a field, a string that is
concatenated once, a route that only forwards to another route.

## The clock

No clock helper exists. Tests use mock timers Node's own runner ships with:

```js
t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
t.mock.timers.tick(29 * 60 * 1000);   // half an hour later
```

One clock to keep, rather than two.
