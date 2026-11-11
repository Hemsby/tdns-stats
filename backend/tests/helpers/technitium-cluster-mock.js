'use strict';

const { createTechnitiumServer } = require('./technitium-mock');
const { buildTechnitiumData, buildProfile, makeRandom, shuffle } = require('./technitium-data-gen');

/**
 * A profile for every node of the cluster.
 *
 * Each node is its own resolver with its own traffic: its own names, its own
 * clients, its own mix of cached and recursive answers. The volumes are
 * spread over the range between them and shuffled, so no two nodes carry the
 * same amount of traffic and the cluster has no obvious order.
 */
function buildClusterProfiles(seed, count) {
    const random = makeRandom(seed ^ 0x85ebca6b);
    const profiles = [];
    for (let i = 0; i < count; i++) profiles.push(buildProfile(random));

    const step = 520 / count;
    const slots = shuffle(
        random,
        profiles.map((_, i) => 60 + step * i),
    );
    profiles.forEach((profile, i) => {
        // The slot and the jitter keep a node inside its own band of the
        // range, so the volumes never land on each other.
        profile.baseline = Math.floor(slots[i] + random() * step);
    });
    return profiles;
}

/**
 * A cluster of mock Technitium nodes.
 *
 * Every node runs its own server, the way a real cluster does, and each one
 * reports the others in /api/admin/cluster/state. The first node is the
 * primary; the rest are secondaries. A node sees itself as "Self" and the
 * others as "Connected".
 *
 * options:
 *   seed    - the seed for the generator (default 1)
 *   count   - how many nodes to create (default 3)
 *   domain  - the cluster domain (default 'cluster.home.arpa')
 *   port    - the port the first node listens on; the rest follow it. The
 *             nodes take an ephemeral port when it is not given.
 */
async function createTechnitiumCluster(options = {}) {
    const seed = options.seed ?? 1;
    const count = options.count ?? 3;
    const domain = options.domain || 'cluster.home.arpa';
    const port = options.port || 0;

    const names = Array.from({ length: count }, (_, i) => `ns${i + 1}.${domain}`);
    const nodes = [];
    const servers = [];
    const profiles = buildClusterProfiles(seed, count);

    for (let i = 0; i < count; i++) {
        const node = {
            id: `node-${i + 1}`,
            name: names[i],
            type: i === 0 ? 'Primary' : 'Secondary',
            state: 'Connected',
            ipAddresses: [`10.10.0.${i + 1}`],
            upSince: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
            lastSeen: new Date(Date.now() - 60000).toISOString(),
            configLastSynced: new Date(Date.now() - 45000).toISOString(),
            url: '',
        };
        nodes.push(node);
    }

    // The nodes need each other's URLs, and a URL needs the port the server
    // ended up on, so the servers are started first and linked afterwards.
    const worlds = [];
    for (let i = 0; i < count; i++) {
        const world = buildTechnitiumData({
            seed: seed + i,
            name: names[i],
            profile: profiles[i],
            cluster: { domain, nodes },
        });
        // This node sees itself as "Self"; the rest are just connected. The
        // list is built when the state is asked for, because a node's URL is
        // only known once its server is listening.
        world.clusterState = () => ({
            clusterDomain: domain,
            clusterNodes: nodes.map((node, index) => ({
                ...node,
                state: index === i ? 'Self' : 'Connected',
            })),
        });
        worlds.push(world);
    }

    for (let i = 0; i < count; i++) {
        // A node knows its siblings, so a request for the cluster is answered
        // with the totals of every node and a request for a node by name with
        // that node's own data.
        const cluster = () => servers.map((server, index) => ({ name: names[index], state: server.state }));
        const server = createTechnitiumServer({ ...worlds[i], cluster });
        await server.start(port ? port + i : 0);
        servers.push(server);
    }

    for (let i = 0; i < count; i++) {
        nodes[i].url = servers[i].url;
    }

    return {
        domain,
        nodes,
        servers,
        /** The server config for one node, the way config.yml holds it. */
        serverConfig(index, extra = {}) {
            const server = servers[index];
            return {
                name: nodes[index].name,
                url: server.url,
                token: 'test-token',
                ignoreSsl: false,
                queryLogsAppName: null,
                queryLogsApp: null,
                ...extra,
            };
        },
        async stop() {
            await Promise.all(servers.map(server => server.stop()));
        },
    };
}

module.exports = { createTechnitiumCluster };
