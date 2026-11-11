'use strict';

/**
 * Realistic Technitium data.
 *
 * The unit tests in technitium.test.js only need one field at a time, so they
 * pass their own fixtures. This file is the other half: a whole Technitium
 * server's worth of data, shaped and moving the way a real one is, so the
 * dashboard can be driven end to end: every card, every list, the feed, the
 * cache and the blocked lookup. A cluster can be stood up without a real
 * cluster because of it.
 *
 * The data is generated from a seed, so the same seed always produces the same
 * numbers, but it is not a loop of repeated values. The volume follows the
 * time of day, the mix of answers follows the load, the response times have
 * the long tail a resolver really has, and the popular names are popular in
 * the same places (in the query log and in the top lists), so the dashboard
 * shows one story rather than several.
 *
 * The one thing that moves is the clock: query log entries are built around
 * the time they are asked for, because a feed that replays the same fixed rows
 * is consumed by the first poll and every later poll sees nothing.
 */

const DOMAINS = [
    'www.wikipedia.org',
    'api.github.com',
    'mail.google.com',
    'cdn.jsdelivr.net',
    'www.amazon.com',
    'login.microsoftonline.com',
    'res.cdn.office.net',
    'docs.python.org',
    'updates.mozilla.org',
    'img.youtube.com',
    'video.twitch.tv',
    'auth.apple.com',
    'git.sr.ht',
    'registry.npmjs.org',
    'metrics.datadoghq.com',
    'search.brave.com',
    'files.slack.com',
    'app.uber.com',
    'status.slack.com',
    'chat.google.com',
    'blog.github.com',
    'support.mozilla.org',
    'news.ycombinator.com',
    'forum.proxmox.com',
];

const TRACKING_DOMAINS = [
    'ads.doubleclick.net',
    'pixel.facebook.com',
    'beacon.adsrvr.org',
    'telemetry.newrelic.com',
    'collect.googleadservices.com',
    'profile.qualtrics.com',
    'logs.amplitude.com',
    'sync.googleadservices.com',
    'tag.tiqcdn.com',
    'report.adsrvr.org',
];

const CLIENTS = [
    '192.168.1.10',
    '192.168.1.24',
    '192.168.2.7',
    '10.0.0.31',
    '10.0.0.44',
    '172.16.4.19',
    '89.160.20.112',
    '84.64.15.7',
    '194.36.144.42',
    '2a03:2880:f003:c07:face:b00c:0:25de',
    '2606:4700:4700::1111',
    '77.91.110.3',
];

const QTYPE_NAMES = ['A', 'A', 'A', 'AAAA', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'HTTPS', 'PTR', 'SOA'];

// The addresses a resolver answers with, the way a real one does: the address
// the name really has, not a made up one.
const ADDRESSES = ['104.18.32.47', '172.217.16.142', '151.101.65.69', '93.184.216.34', '13.107.42.14', '142.250.185.78'];

const IPV6_ADDRESSES = ['2606:2800:220:1:248:1893:25c8:1946', '2a00:1450:4009:81f::200e', '2606:4700:4700::1111'];

// The block lists Technitium v15.6.2 ships with, so a name is blocked by the
// same lists a real server blocks it by.
const BLOCK_LIST_URLS = [
    'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/light-onlydomains.txt',
    'https://cdn.jsdelivr.net/gh/hagezi/nrd@latest/domains/nrd7.txt',
    'https://big.oisd.nl/domainswild2',
];

/**
 * A small seeded generator, so the same seed always gives the same data.
 */
function makeRandom(seed) {
    let state = seed >>> 0;
    return function random() {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A number from a string, so a name always draws the same numbers.
 *
 * A domain that is looked up twice has to be answered the same way both
 * times: the same block list, the same address. The seed of a domain is
 * derived from its name, not from the order the lookups arrive in.
 */
function hashString(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function pick(random, list) {
    return list[Math.floor(random() * list.length)];
}

function between(random, low, high) {
    return low + Math.floor(random() * (high - low + 1));
}

/** A list in a new order. */
function shuffle(random, list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * One of a set of names, chosen by weight.
 *
 * The weights are shares of the traffic, so the name that is asked for
 * constantly is the one that comes up.
 */
function weightedPick(random, items) {
    const roll = random();
    let total = 0;
    for (const item of items) {
        total += item.weight;
        if (roll <= total) return item.name;
    }
    return items[0].name;
}

/** Weights as shares of the whole, so they can be counted with. */
function toShares(items) {
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    return items.map(item => ({ ...item, weight: item.weight / total }));
}

const NAME_WORDS = ['api', 'cdn', 'mail', 'files', 'auth', 'git', 'metrics', 'status', 'vpn', 'backup', 'shop', 'news'];

// More names the node is asked for, so a long tail of the list is made of
// names a real resolver would see.
const EXTRA_DOMAINS = [
    'accounts.google.com',
    'clients.l.google.com',
    'edge-chat.facebook.com',
    'edge.map.fastly.net',
    'in-fae.ecs.amazonaws.com',
    'ia801504.us.archive.org',
    'r23.auth.microsoft.com',
    'a.ths.google.com',
    'ipv4.cdn.mozilla.net',
    'jsdelivr-cdn.global.ssl.fastly.net',
    'ocsp.digicert.com',
    'play.google.com',
    'push.services.mozilla.com',
    'safebrowsing.googleapis.com',
    'swr.cdn.bunny.net',
    'time.cloudflare.com',
];

/**
 * The names a node is asked for.
 *
 * A few of them are asked for constantly and the rest fade away, which is
 * the shape a real top list has: a long head and a short tail. Every node
 * has its own names, so two nodes of a cluster do not look alike.
 */
function pickDomains(random) {
    const names = shuffle(random, DOMAINS).slice(0, between(random, 10, 18));
    for (let i = 0; i < between(random, 1, 4); i++) {
        names.push(pick(random, EXTRA_DOMAINS));
    }

    // The head of the list carries the traffic. The weights fall away by a
    // fixed step, so the list and the log always agree on which names are
    // the popular ones.
    const head = 0.28 + random() * 0.14;
    const headWeights = [head, head * 0.62, head * 0.38];
    const tail = names.slice(3).map((name, index) => ({ name, weight: 0.035 * Math.pow(index + 1, -1.4) }));
    return toShares([...headWeights.map((weight, index) => ({ name: names[index], weight })), ...tail]);
}

/**
 * The clients a node serves.
 *
 * The clients are more alike than the names are: a few are busy and the rest
 * are only a little.
 */
function pickClients(random) {
    const names = shuffle(random, CLIENTS).slice(0, between(random, 4, 9));
    for (let i = 0; i < between(random, 1, 5); i++) {
        names.push(`192.168.${between(random, 1, 40)}.${between(random, 2, 254)}`);
    }
    return toShares(
        names.map((name, index) => ({
            name,
            weight: Math.pow(index + 1, -0.6),
            // Some clients have a PTR record, and the server shows the name it
            // resolves to under the address.
            domain: random() < 0.35 ? `${pick(random, NAME_WORDS)}-${between(random, 1, 40)}.lan.home.arpa` : undefined,
        })),
    );
}

/** The names a node blocks and how often each one is asked for. */
function pickTracking(random) {
    const names = shuffle(random, TRACKING_DOMAINS);
    const head = 0.36 + random() * 0.14;
    const headWeights = [head, head * 0.6, head * 0.36];
    const tail = names.slice(3).map((name, index) => ({ name, weight: 0.04 * Math.pow(index + 1, -1.3) }));
    return toShares([...headWeights.map((weight, index) => ({ name: names[index], weight })), ...tail]);
}

/**
 * A node's own character: how much traffic it carries, what that traffic is
 * made of, when it is busy, how fast it answers and who asks for it.
 *
 * Two nodes of one cluster are never alike, and a node built twice from the
 * same seed always is alike. The profile is drawn from a random of its own,
 * so the shape of the traffic does not move when the numbers it produces do.
 */
function buildProfile(random) {
    // The blocked queries have a response type of their own, so the answers
    // share what is left of the traffic between them.
    const blocked = 0.002 + random() * 0.13;
    const responses = {
        cached: 0.05 + random() * 0.55,
        recursive: 0.05 + random() * 0.4,
        authoritative: 0.02 + random() * 0.22,
        dropped: random() * 0.04,
    };
    const responseTotal = Object.values(responses).reduce((a, b) => a + b, 0);
    const scale = (1 - blocked) / responseTotal;
    for (const key of Object.keys(responses)) responses[key] *= scale;

    return {
        // The queries a busy minute holds.
        baseline: between(random, 60, 520),
        // The hours the node is busy at.
        curve: {
            peakHour: between(random, 7, 21) + random(),
            peakWidth: between(random, 4, 22),
            eveningPeak: random() * 0.9,
            eveningHour: between(random, 18, 22) + random(),
            eveningWidth: between(random, 3, 8),
            nightFloor: random() * 0.3,
        },
        responses,
        errors: {
            blocked,
            nxDomain: 0.005 + random() * 0.09,
            serverFailure: random() * 0.025,
            refused: random() * 0.015,
        },
        latency: {
            base: 0.3 + random() * 3,
            perLoad: 1 + random() * 3,
            tail: 2 + random() * 2.4,
            retryChance: 0.003 + random() * 0.04,
        },
        domains: pickDomains(random),
        clients: pickClients(random),
        tracking: pickTracking(random),
        cacheEntries: between(random, 400, 2200),
        zones: between(random, 5, 60),
        allowedZones: between(random, 0, 12),
        blockedZones: between(random, 0, 8),
        allowListZones: between(random, 0, 6),
        blockListZones: between(random, 0, 6),
    };
}

/** The hours of a day with no profile of its own. */
const DEFAULT_CURVE = {
    peakHour: 14,
    peakWidth: 18,
    eveningPeak: 0.45,
    eveningHour: 20,
    eveningWidth: 5,
    nightFloor: 0.08,
};

/** The response times of a node with no profile of its own. */
const DEFAULT_LATENCY = { base: 1, perLoad: 2.4, tail: 2.4, retryChance: 0.015 };

/**
 * How busy a minute is, by the hour of the day.
 *
 * A working day and a smaller evening peak, with the small hours of the
 * morning quiet. A resolver in an office network looks like this. A node
 * with a profile of its own keeps its own hours.
 */
function trafficCurve(at, profile) {
    const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
    const curve = profile ? profile.curve : DEFAULT_CURVE;
    const working = Math.exp(-((hour - curve.peakHour) ** 2) / curve.peakWidth);
    const evening = curve.eveningPeak * Math.exp(-((hour - curve.eveningHour) ** 2) / curve.eveningWidth);
    return curve.nightFloor + working + evening;
}

/**
 * The extra load on one minute.
 *
 * Most minutes are ordinary. A few are a scan or a busy client, and those
 * are the minutes where the errors and the drops show up.
 */
function burstFactor(random) {
    const roll = random();
    if (roll > 0.97) return between(random, 2.4, 5);
    if (roll > 0.88) return between(random, 1.3, 2);
    return between(random, 70, 125) / 100;
}

/**
 * The response time of one query, in milliseconds.
 *
 * Most answers are quick and a few are slow, because the upstream took its
 * time or a packet was lost and the query was tried again. The tail is what
 * makes P95 and P99 different from the median, and a busy minute is slower
 * than a quiet one.
 */
function latency(random, load, profile) {
    const shape = profile ? profile.latency : DEFAULT_LATENCY;
    const base = shape.base + load * shape.perLoad;
    const tail = Math.exp(random() * shape.tail);
    const retry = random() < shape.retryChance ? between(random, 35, 160) : 0;
    return Math.round((base * tail + retry) * 10) / 10;
}

/**
 * The chance a name is asked for.
 *
 * A few names are asked for constantly and the rest fade away, so the top
 * list has the shape a real one has: a long head and a short tail.
 */
function pickDomain(random, profile) {
    return weightedPick(random, profile.domains);
}

/**
 * One minute of traffic: the counts the chart draws and the load the
 * response times follow.
 */
function buildMinute(random, at, baseline, profile, drift) {
    const load = trafficCurve(at, profile) * burstFactor(random) * drift;
    const queries = Math.max(1, Math.round(baseline * load));

    // The mix is the node's own. A busy minute fails a little more.
    const error = name => profile.errors[name] * (0.85 + random() * 0.3);

    // The response types are one answer per query, so they share the traffic
    // that was not blocked. The mix moves a little from minute to minute, but
    // the answers always add up to the traffic they have to answer.
    const blocked = Math.round(queries * error('blocked'));
    const mix = {
        cached: profile.responses.cached * (0.85 + random() * 0.3),
        recursive: profile.responses.recursive * (0.85 + random() * 0.3),
        authoritative: profile.responses.authoritative * (0.85 + random() * 0.3),
        dropped: profile.responses.dropped * (0.85 + random() * 0.3),
    };
    const mixTotal = mix.cached + mix.recursive + mix.authoritative + mix.dropped;
    const scale = mixTotal > 0 ? (queries - blocked) / mixTotal : 0;

    const cached = Math.round(mix.cached * scale);
    const recursive = Math.round(mix.recursive * scale);
    const authoritative = Math.round(mix.authoritative * scale);
    const dropped = Math.round(mix.dropped * scale);
    const nxDomain = Math.round(queries * error('nxDomain'));
    const serverFailure = Math.round(queries * error('serverFailure'));
    const refused = Math.round(queries * error('refused'));
    const noError = Math.max(0, queries - nxDomain - serverFailure - refused);
    const clients = Math.min(profile.clients.length, Math.max(1, Math.round(queries * (0.02 + random() * 0.05))));

    return {
        at,
        load,
        counts: {
            Total: queries,
            'No Error': noError,
            Blocked: blocked,
            Cached: cached,
            Recursive: recursive,
            Authoritative: authoritative,
            'NX Domain': nxDomain,
            'Server Failure': serverFailure,
            Dropped: dropped,
            Refused: refused,
            Clients: clients,
        },
        stats: {
            totalQueries: queries,
            totalNoError: noError,
            totalBlocked: blocked,
            totalCached: cached,
            totalRecursive: recursive,
            totalAuthoritative: authoritative,
            totalNxDomain: nxDomain,
            totalServerFailure: serverFailure,
            totalDropped: dropped,
            totalRefused: refused,
            totalClients: clients,
        },
    };
}

/** The per-minute series the dashboard chart draws. */
function buildChartData(random, minutes, baseline, profile) {
    const labels = [];
    const now = new Date();
    now.setUTCSeconds(0, 0);

    const series = [];
    // The volume drifts the way a real one does: a wave of traffic that
    // comes and goes over the minutes.
    let drift = 1;
    for (let i = minutes - 1; i >= 0; i--) {
        const at = new Date(now.getTime() - i * 60000);
        drift = 0.75 * drift + 0.25 * (0.6 + random() * 0.8);
        labels.push(at.toISOString());
        series.push(buildMinute(random, at, baseline, profile, drift));
    }

    const datasetFor = name => series.map(minute => minute.counts[name]);
    const statFor = name => series.reduce((total, minute) => total + minute.stats[name], 0);

    return {
        mainChartData: {
            labelFormat: 'HH:mm',
            labels,
            // The datasets come in the order the server sends them, so the
            // legend of the dashboard reads the same with the mock as with a
            // real Technitium.
            datasets: [
                { label: 'Total', data: datasetFor('Total') },
                { label: 'No Error', data: datasetFor('No Error') },
                { label: 'Server Failure', data: datasetFor('Server Failure') },
                { label: 'NX Domain', data: datasetFor('NX Domain') },
                { label: 'Refused', data: datasetFor('Refused') },
                { label: 'Authoritative', data: datasetFor('Authoritative') },
                { label: 'Recursive', data: datasetFor('Recursive') },
                { label: 'Cached', data: datasetFor('Cached') },
                { label: 'Blocked', data: datasetFor('Blocked') },
                { label: 'Dropped', data: datasetFor('Dropped') },
                { label: 'Clients', data: datasetFor('Clients') },
            ],
        },
        // The counts are flat, the way Technitium returns them: the poller
        // reads node.stats.stats.totalQueries.
        stats: {
            totalQueries: statFor('totalQueries'),
            totalNoError: statFor('totalNoError'),
            totalServerFailure: statFor('totalServerFailure'),
            totalNxDomain: statFor('totalNxDomain'),
            totalRefused: statFor('totalRefused'),
            totalAuthoritative: statFor('totalAuthoritative'),
            totalRecursive: statFor('totalRecursive'),
            totalCached: statFor('totalCached'),
            totalBlocked: statFor('totalBlocked'),
            totalDropped: statFor('totalDropped'),
            totalClients: statFor('totalClients'),
            zones: profile.zones,
            cachedEntries: profile.cacheEntries,
            allowedZones: profile.allowedZones,
            blockedZones: profile.blockedZones,
            allowListZones: profile.allowListZones,
            blockListZones: profile.blockListZones,
        },
    };
}

/**
 * The three top lists, counted the same way the query log counts them, so a
 * name that is popular in the log is popular in the list.
 */
function buildTopLists(random, totalQueries, mix, profile) {
    // The names share the traffic that was not blocked, and the clients
    // share the traffic between them.
    const domainTraffic = totalQueries * (1 - mix.blocked);
    const topDomains = profile.domains
        .map(domain => ({
            name: domain.name,
            hits: Math.max(1, Math.round(domainTraffic * domain.weight)),
        }))
        .sort((a, b) => b.hits - a.hits);

    const blockedTotal = totalQueries * mix.blocked;
    const topBlockedDomains = profile.tracking
        .map(name => ({
            name: name.name,
            hits: Math.max(1, Math.round(blockedTotal * name.weight)),
        }))
        .sort((a, b) => b.hits - a.hits);

    // A client has a domain only when it has a PTR record, and the server
    // says so with the same fields it uses for a real client.
    const topClients = profile.clients
        .map(client => ({
            name: client.name,
            ...(client.domain ? { domain: client.domain } : {}),
            hits: Math.max(1, Math.round(totalQueries * client.weight)),
            rateLimited: false,
        }))
        .sort((a, b) => b.hits - a.hits);

    return { topDomains, topBlockedDomains, topClients };
}

/**
 * The mix of answers, as shares of the traffic.
 *
 * The chart, the query log and the top lists are all told the same mix, so
 * the badge counts on the feed and the counts on the cards agree instead of
 * telling three different stories.
 */
function buildMix(stats) {
    const total = stats.totalQueries || 1;
    return {
        blocked: stats.totalBlocked / total,
        cached: stats.totalCached / total,
        recursive: stats.totalRecursive / total,
        authoritative: stats.totalAuthoritative / total,
        dropped: stats.totalDropped / total,
        nxDomain: stats.totalNxDomain / total,
        serverFailure: stats.totalServerFailure / total,
        refused: stats.totalRefused / total,
    };
}

/** The answer a query gets, drawn from the mix. */
/**
 * The answer a query gets, drawn from the mix.
 *
 * These are the response types the server really sends: an answer from the
 * server itself, one from an upstream, one from its cache, a request it
 * dropped and a request it blocked. There is no answer type for a query
 * that simply worked: that is the response code, not the response type.
 */
function pickResponseType(random, mix) {
    const roll = random();
    if (roll < mix.cached) return 'Cached';
    if (roll < mix.cached + mix.recursive) return 'Recursive';
    if (roll < mix.cached + mix.recursive + mix.authoritative) return 'Authoritative';
    if (roll < mix.cached + mix.recursive + mix.authoritative + mix.dropped) return 'Dropped';
    return 'Authoritative';
}

/** The record types the cache holds for a name. */
function cachedTypesFor(cache, qname) {
    const records = cache?.names?.[String(qname || '').toLowerCase()] || [];
    return [...new Set(records.map(record => record.type))];
}

/** One row of the query log, shaped the way Technitium returns it. */
function buildLogEntry(random, timestamp, load, mix, profile, rowNumber, cache) {
    const isBlocked = random() < mix.blocked;
    const qname = isBlocked ? weightedPick(random, profile.tracking) : pickDomain(random, profile);
    const responseType = isBlocked ? 'Blocked' : pickResponseType(random, mix);

    // A query answered from the cache was answered with a record the cache
    // holds, so the type of the query is one the cache has for that name. A
    // query the cache does not hold was answered from somewhere else.
    const cachedTypes = cachedTypesFor(cache, qname);
    const qtype = responseType === 'Cached' ? pick(random, cachedTypes.length ? cachedTypes : ['A', 'AAAA']) : pick(random, QTYPE_NAMES);

    // The response code says how the answer went. These are the names the
    // server sends: NoError, NxDomain, ServerFailure and Refused.
    let rcode = 'NoError';
    if (responseType !== 'Blocked') {
        const roll = random();
        if (roll < mix.nxDomain) rcode = 'NxDomain';
        else if (roll < mix.nxDomain + mix.serverFailure) rcode = 'ServerFailure';
        else if (roll < mix.nxDomain + mix.serverFailure + mix.refused) rcode = 'Refused';
    }

    const entry = {
        rowNumber,
        timestamp: new Date(timestamp).toISOString(),
        clientIpAddress: weightedPick(random, profile.clients),
        protocol: random() < 0.85 ? 'Udp' : 'Tcp',
        responseType,
        rcode,
        qname,
        qtype,
        qclass: 'IN',
        answer: null,
    };
    // Only an answer that was really sent has a measured round-trip time. A
    // query the server refused never left it, so it has no time either.
    if ((responseType === 'Recursive' || responseType === 'Cached') && rcode !== 'Refused') {
        entry.responseRtt = latency(random, load, profile);
    }
    // The answer is the record the server sent, the way the query log writes
    // it: the type and the data, or nothing at all when there was no answer.
    if (isBlocked) {
        entry.answer = 'A 0.0.0.0';
    } else if (responseType === 'Cached') {
        const record = (cache?.names?.[String(qname || '').toLowerCase()] || []).find(r => r.type === qtype);
        if (record) entry.answer = `${record.type} ${record.rData.ipAddress}`;
    }
    return entry;
}

/**
 * The query log, newest first, built around the moment it is asked for.
 *
 * The rows are spread over the last few minutes and their response times
 * follow the load of the minute they fall in. The row numbers only go up,
 * the way the rows of a real log do, so the feed can tell a new row from
 * one it has already shown.
 */
function buildLogEntries(random, count, now, mix, profile, nextRowNumber, cache) {
    const base = now instanceof Date ? now.getTime() : now;
    const entries = [];
    for (let i = count - 1; i >= 0; i--) {
        const minutesAgo = Math.floor(i / 20);
        const at = new Date(base - minutesAgo * 60000 - i * 2600);
        const load = trafficCurve(at, profile) * burstFactor(random);
        entries.push(buildLogEntry(random, at.getTime(), load, mix, profile, nextRowNumber(), cache));
    }
    return entries.reverse();
}

/** The zone a name belongs to. */
function zoneOf(name) {
    return String(name || '')
        .split('.')
        .slice(-2)
        .join('.');
}

/**
 * The TTL of a cached record, the way a real server reports it: the seconds
 * it has left, and the same time in words.
 */
function cacheTtl(random) {
    const seconds = between(random, 30, 7200);
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (!minutes) return `${seconds} (${seconds} sec)`;
    if (!rest) return `${seconds} (${minutes} mins)`;
    return `${seconds} (${minutes} mins ${rest} sec)`;
}

/**
 * The cache a node holds.
 *
 * A resolver caches what it has answered, so the cache holds the names the
 * node served, with the records it kept for them. A name the node never
 * answered is not in the cache at all, which is what makes a cache search for
 * an unknown name come back empty instead of handing out the whole cache.
 *
 * A name the node serves has an address for IPv4 and one for IPv6, because a
 * resolver that answered a name for a client keeps both. The zone a name sits
 * under keeps the records of the zone itself.
 *
 * The records are shaped the way Technitium shapes them: the name, the type,
 * the ttl, and the data of the record under `rData`.
 */
function buildCache(random, profile) {
    const names = {};

    for (const { name } of profile.domains) {
        names[name] = [
            {
                name,
                type: 'A',
                ttl: cacheTtl(random),
                rData: { ipAddress: pick(random, ADDRESSES) },
            },
            {
                name,
                type: 'AAAA',
                ttl: cacheTtl(random),
                rData: { ipAddress: pick(random, IPV6_ADDRESSES) },
            },
        ];
    }

    // The zone a name sits under keeps the records of the zone itself.
    for (const zone of [...new Set(profile.domains.map(({ name }) => zoneOf(name)))]) {
        if (names[zone]) continue;
        names[zone] = [
            { name: zone, type: 'MX', ttl: cacheTtl(random), rData: { preference: 10, exchange: `mail.${zone}` } },
            { name: zone, type: 'TXT', ttl: cacheTtl(random), rData: { text: 'v=spf1 -all' } },
        ];
    }

    // A signed name is kept on its own, the way a resolver keeps the DNSSEC
    // records of a name it has answered nothing else for.
    names['signed.home.arpa'] = [
        {
            name: 'signed.home.arpa',
            type: 'DS',
            ttl: cacheTtl(random),
            rData: {
                keyTag: 370,
                algorithm: '13',
                algorithmNumber: 13,
                digestType: '2',
                digestTypeNumber: 2,
                digest: '8F2C1D2A5B3E7F9012C4D6E8A0B2C4D6E8A0B2C4D6E8A0B2C4D6E8A0B2C4D6E',
            },
        },
    ];

    return { names };
}

/**
 * The cache as a tree of names.
 *
 * A real cache is a tree: every name sits under the name above it, and the
 * root of the tree is the empty name. The tree is worked out from the names
 * that are held, so a name that is not held has no place in it at all.
 */
function cacheTree(cache) {
    const nodes = new Map();
    const ensure = name => {
        if (!nodes.has(name)) nodes.set(name, { records: [], children: [] });
        return nodes.get(name);
    };
    ensure('');

    for (const [name, records] of Object.entries(cache?.names || {})) {
        const labels = String(name).toLowerCase().split('.').filter(Boolean);
        for (let i = 0; i < labels.length; i++) {
            const part = labels.slice(i).join('.');
            // The parent of a name is the name it sits under, which is the rest
            // of the labels below it. The last label sits under the root.
            const parent = i === labels.length - 1 ? '' : labels.slice(i + 1).join('.');
            ensure(part);
            const parentNode = ensure(parent);
            if (!parentNode.children.includes(part)) parentNode.children.push(part);
        }
        ensure(String(name).toLowerCase()).records.push(...(records || []));
    }

    return nodes;
}

/**
 * The part of a cache that answers for one name.
 *
 * A cache list is asked for a name, so the answer is what the node holds for
 * that name: the records at that name, and the names of the zones under it.
 * When the name holds no records of its own but leads to exactly one zone,
 * the server walks into that zone and answers for it, the way a real one
 * does. A name the node never answered has nothing in the cache, and the
 * answer is empty.
 */
function cacheForDomain(cache, domain, direction = 'down') {
    const nodes = cacheTree(cache);
    const name = String(domain || '')
        .trim()
        .toLowerCase()
        .replace(/\.+$/, '');

    let current = name;
    for (;;) {
        const node = nodes.get(current);
        const records = node?.records || [];
        const children = [...(node?.children || [])].sort();
        if (records.length) return { domain: current, zones: children, records };
        if (children.length !== 1) return { domain: current, zones: children, records: [] };

        if (direction === 'up') {
            if (!current) break;
            const dot = current.indexOf('.');
            current = dot < 0 ? '' : current.slice(dot + 1);
        } else {
            current = children[0];
        }
    }

    const node = nodes.get(current);
    return { domain: current, zones: [...(node?.children || [])].sort(), records: [] };
}

/**
 * A record of a DNS answer, shaped the way Technitium shapes it.
 */
function buildDnsRecord(name, type, ttl, rData) {
    return {
        Name: name,
        Type: type,
        Class: 'IN',
        TTL: ttl,
        RDLENGTH: '4 bytes',
        RDATA: rData,
    };
}

/**
 * The answer to a DNS query, shaped the way Technitium answers it.
 *
 * The answer is the datagram the server sent back: the question that was
 * asked, the records that answer it, and the records that came with it.
 */
function buildDnsAnswer(domain, type, answer, additional = []) {
    return {
        result: {
            Metadata: {
                NameServer: 'ns1.home.arpa:53 (127.0.0.1:53)',
                Protocol: 'Udp',
                DatagramSize: '45 bytes',
                RoundTripTime: '1.42 ms',
            },
            Identifier: 60127,
            IsResponse: true,
            OPCODE: 'StandardQuery',
            AuthoritativeAnswer: false,
            Truncation: false,
            RecursionDesired: true,
            RecursionAvailable: true,
            Z: 0,
            AuthenticData: false,
            CheckingDisabled: false,
            RCODE: 'NoError',
            QDCOUNT: 1,
            ANCOUNT: answer.length,
            NSCOUNT: 0,
            ARCOUNT: additional.length,
            Question: [{ Name: domain, Type: type, Class: 'IN' }],
            Answer: answer,
            Authority: [],
            Additional: additional,
        },
        rawResponses: [],
    };
}

/**
 * The report a blocking app sends for a name it blocked.
 *
 * The keys are the ones Technitium uses: the source of the report, the list
 * that matched, and the name the list matched.
 */
function blockingReport(domain, listUrl, source) {
    return `source=${source}; blockListUrl=${listUrl}; domain=${domain}`;
}

/**
 * The DNS answer for a name, so the blocked lookup has something to find.
 *
 * A blocked name is answered with the report of every list that carries it,
 * one TXT record for each of them, the way the built-in block list zone
 * reports it. A TXT query is answered with those reports; an address query is
 * answered with the address the server blocks with, and the report goes into
 * the extended error of the answer, which is not part of the records.
 *
 * Everything about a name is drawn from the name itself, so the same name is
 * always answered the same way: the same block lists report it and it always
 * resolves to the same address. A block list can still change over time -
 * that is the list's business, not the server's, but the server does not
 * make a name change its mind from one lookup to the next.
 */
function buildResolveAnswer(query) {
    const domain = query.domain;
    const type = String(query.type || 'A').toUpperCase();
    const random = makeRandom(hashString(String(domain || '').toLowerCase()));

    if (TRACKING_DOMAINS.includes(domain)) {
        const lists = blockListsFor(domain);
        if (type === 'TXT') {
            const answer = lists.urls.map(url =>
                buildDnsRecord(domain, 'TXT', 3600, { CharacterStrings: [blockingReport(domain, url, lists.source)] }),
            );
            return buildDnsAnswer(domain, type, answer);
        }
        // The address a blocked name is answered with is the address the
        // server blocks with.
        const rData = type === 'AAAA' ? { IPAddress: '::' } : { IPAddress: '0.0.0.0' };
        return buildDnsAnswer(domain, type, [buildDnsRecord(domain, type, 3600, rData)]);
    }

    if (type === 'TXT') {
        return buildDnsAnswer(domain, type, [buildDnsRecord(domain, 'TXT', 3600, { CharacterStrings: ['v=spf1 -all'] })]);
    }
    const rData = type === 'AAAA' ? { IPAddress: pick(random, IPV6_ADDRESSES) } : { IPAddress: pick(random, ADDRESSES) };
    return buildDnsAnswer(domain, type, [buildDnsRecord(domain, type, 300, rData)]);
}

/**
 * The block lists a name is on.
 *
 * The lists overlap: a tracker list and a malware list can both carry the
 * same name, so a name can be on one list, on two, or on three. How many
 * lists a name is on, and which ones, is drawn from the name itself, so the
 * same name is always on the same lists.
 *
 * The built-in block list zone reports every list that matched. The Advanced
 * Blocking App reports only the first one it finds, so a name it blocks is
 * reported with a single list even when more of them carry it.
 */
function blockListsFor(domain) {
    const name = String(domain || '').toLowerCase();
    const random = makeRandom(hashString(name));
    const count = 1 + Math.floor(random() * 3);
    const urls = shuffle(random, BLOCK_LIST_URLS).slice(0, count);
    const advanced = hashString(name + ':app') % 4 === 0;
    return {
        source: advanced ? 'advanced-blocking-app' : 'block-list-zone',
        urls: advanced ? urls.slice(0, 1) : urls,
    };
}

/**
 * The cluster's own totals.
 *
 * A cluster is asked for its totals with `node=cluster`, and the answer is
 * every node's numbers added together: the counters, the chart series and
 * the top lists, where a name several nodes saw has their hits added up.
 *
 * nodes - the nodes of the cluster, each one { dashboard, topStats }
 */
function aggregateCluster(nodes) {
    const list = nodes.filter(Boolean);
    const dashboards = list.map(node => node.dashboard).filter(Boolean);

    // The chart series are added up minute by minute. The nodes do not
    // necessarily start at the same minute, so the minutes are matched by
    // their label rather than by their position.
    const labels = new Set();
    for (const dashboard of dashboards) {
        for (const label of dashboard.mainChartData?.labels || []) labels.add(label);
    }
    const ordered = [...labels].sort();
    const at = new Map(ordered.map((label, index) => [label, index]));

    const names = (dashboards[0]?.mainChartData?.datasets || []).map(dataset => dataset.label);
    const datasets = names.map(name => {
        const data = new Array(ordered.length).fill(0);
        for (const dashboard of dashboards) {
            const dataset = (dashboard.mainChartData?.datasets || []).find(d => d.label === name);
            if (!dataset) continue;
            const own = dashboard.mainChartData.labels || [];
            for (let i = 0; i < own.length; i++) {
                const index = at.get(own[i]);
                if (index === undefined) continue;
                data[index] += dataset.data?.[i] || 0;
            }
        }
        return { label: name, data };
    });

    const stats = {};
    for (const dashboard of dashboards) {
        for (const [key, value] of Object.entries(dashboard.stats || {})) {
            if (typeof value !== 'number') continue;
            stats[key] = (stats[key] || 0) + value;
        }
    }

    return {
        dashboard: { mainChartData: { labels: ordered, datasets }, stats },
        topStats: aggregateTopStats(list.map(node => node.topStats)),
    };
}

/** The top lists of several nodes, with the hits of a shared name added up. */
function aggregateTopStats(list) {
    const out = {};
    for (const topStats of list) {
        for (const [statsType, payload] of Object.entries(topStats || {})) {
            const key = Object.keys(payload || {})[0];
            if (!key) continue;
            const rows = payload[key] || [];
            const merged = new Map();
            for (const row of out[statsType]?.[key] || []) merged.set(row.name, row);
            for (const row of rows) {
                const current = merged.get(row.name);
                if (!current) {
                    merged.set(row.name, { ...row });
                    continue;
                }
                current.hits = (current.hits || 0) + (row.hits || 0);
                if (row.domain && !current.domain) current.domain = row.domain;
                if (row.rateLimited) current.rateLimited = true;
            }
            out[statsType] = out[statsType] || {};
            out[statsType][key] = [...merged.values()].sort((a, b) => (b.hits || 0) - (a.hits || 0));
        }
    }
    return out;
}

/**
 * A whole Technitium node's worth of data.
 *
 * options:
 *   seed        - the seed for the generator (default 1)
 *   name        - the node's name, used as its dnsServerDomain
 *   cluster     - { domain, nodes } when this node is part of a cluster
 *   minutes     - how many minutes of chart history to build (default 60)
 *   baseline    - the queries a busy minute holds (default: the node's own)
 *   profile     - the node's character, when the caller has one of its own
 */
function buildTechnitiumData(options = {}) {
    const seed = options.seed ?? 1;
    const name = options.name || 'ns1.home.arpa';
    const minutes = options.minutes ?? 60;
    const random = makeRandom(seed);

    // The profile is drawn from a random of its own, so the shape of the
    // traffic does not move when the numbers it produces do. A caller that
    // has a profile of its own (the cluster mock gives every node one) hands
    // it in instead.
    const profile = options.profile || buildProfile(makeRandom(seed ^ 0x9e3779b9));
    const baseline = options.baseline ?? profile.baseline;

    const chartData = buildChartData(random, minutes, baseline, profile);
    const mix = buildMix(chartData.stats);
    const tops = buildTopLists(random, chartData.stats.totalQueries, mix, profile);
    const cache = buildCache(random, profile);

    // The row numbers of a real log only go up, so the feed can tell a new
    // row from one it has already shown.
    let lastRowNumber = between(random, 100000, 900000);
    const nextRowNumber = () => ++lastRowNumber;

    const cluster = options.cluster || null;
    const clusterState = cluster
        ? {
              clusterDomain: cluster.domain,
              clusterNodes: cluster.nodes.map(node => ({
                  id: node.id,
                  name: node.name,
                  url: node.url,
                  type: node.type,
                  state: node.state,
                  ipAddresses: node.ipAddresses,
                  upSince: node.upSince,
                  lastSeen: node.lastSeen,
                  configLastSynced: node.configLastSynced,
              })),
          }
        : {};

    return {
        // The session info, the way the server sends it: the version, the
        // domain of the node and the cluster it belongs to.
        info: {
            version: '15.6.2',
            uptimestamp: new Date(Date.now() - 86400000).toISOString(),
            dnsServerDomain: name,
            defaultRecordTtl: 3600,
            defaultNsRecordTtl: 43200,
            defaultSoaRecordTtl: 3600,
            useSoaSerialDateScheme: false,
            dnssecValidation: false,
            clusterInitialized: Boolean(cluster),
            clusterDomain: cluster ? cluster.domain : null,
            clusterNodes: cluster ? clusterState.clusterNodes : null,
        },
        settings: {
            cacheMaximumEntries: 4096,
            // Whether the server is allowed to report the built-in block lists
            // in a TXT record. The blocked lookup reads this.
            allowTxtBlockingReport: true,
        },
        apps: [
            {
                name: 'Query Logs (Sqlite)',
                description:
                    'Logs all incoming DNS requests and their responses in a Sqlite database that can be queried from the DNS Server web console.',
                version: '9.1.3',
                dnsApps: [
                    {
                        classPath: 'QueryLogsSqlite.App',
                        description:
                            'Logs all incoming DNS requests and their responses in a Sqlite database that can be queried from the DNS Server web console.',
                        isAppRecordRequestHandler: false,
                        isRequestController: false,
                        isAuthoritativeRequestHandler: false,
                        isRequestBlockingHandler: false,
                        isQueryLogger: true,
                        isQueryLogs: true,
                        isPostProcessor: false,
                    },
                ],
            },
        ],
        dashboard: chartData,
        topStats: {
            TopDomains: { topDomains: tops.topDomains },
            TopBlockedDomains: { topBlockedDomains: tops.topBlockedDomains },
            TopClients: { topClients: tops.topClients },
        },
        clusterState,
        cache,
        // The feed asks for the newest rows, so the log is built around the time
        // of the request rather than once at startup.
        logEntries: () => buildLogEntries(random, 300, Date.now(), mix, profile, nextRowNumber, cache),
        resolve: query => buildResolveAnswer(query),
    };
}

module.exports = {
    buildTechnitiumData,
    buildProfile,
    makeRandom,
    hashString,
    shuffle,
    trafficCurve,
    latency,
    aggregateCluster,
    cacheForDomain,
    DOMAINS,
    TRACKING_DOMAINS,
    CLIENTS,
};
