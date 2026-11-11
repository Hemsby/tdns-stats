#!/usr/bin/env node
'use strict';

/**
 * Runs the mock Technitium server so the dashboard can be driven by hand.
 *
 *   node backend/tests/helpers/run-mock.js
 *   node backend/tests/helpers/run-mock.js --cluster 3 --seed 7
 *   node backend/tests/helpers/run-mock.js --cluster 3 --port 34119
 *
 * It prints a config.yml to paste in, then stays up until it is stopped.
 * Nothing here is needed to run the tests; it exists so a person can look at
 * the dashboard with realistic data in it.
 */
const yaml = require('js-yaml');
const { createTechnitiumServer } = require('./technitium-mock');
const { buildTechnitiumData } = require('./technitium-data-gen');
const { createTechnitiumCluster } = require('./technitium-cluster-mock');

// The colours the server hands out when a server has none of its own.
const COLOURS = ['blue', 'green', 'ora', 'teal', 'pur', 'yel', 'red'];

// Every option the server reads, with the values a mock run wants. The
// numbers are the defaults from config.example.yml, so nothing changes
// unless a person edits them.
function mockConfig(servers, names) {
    return {
        port: 3000,
        servers: servers.map((server, index) => ({
            name: names[index],
            url: server.url,
            token: 'test-token',
            ignoreSsl: false,
            queryLogsApp: 'Query Logs (Sqlite)',
            color: COLOURS[index % COLOURS.length],
        })),
        poll: {
            statsInterval: 10,
            feedInterval: 3,
            topInterval: 30,
            perfInterval: 30,
        },
        feed: {
            pageSize: 20,
            maxEntries: 200,
        },
        top: {
            limit: 20,
        },
        debug: false,
    };
}

function readArg(name, fallback) {
    const index = process.argv.indexOf(name);
    if (index === -1) return fallback;
    return process.argv[index + 1];
}

async function main() {
    const seed = Number(readArg('--seed', 1));
    const clusterSize = Number(readArg('--cluster', 0));
    const port = Number(readArg('--port', 0));

    let servers;
    let names;
    if (clusterSize > 1) {
        const cluster = await createTechnitiumCluster({ seed, count: clusterSize, port });
        servers = cluster.servers;
        names = cluster.nodes.map(node => node.name);
        console.log(`Cluster domain: ${cluster.domain}`);
    } else {
        const world = buildTechnitiumData({ seed, name: 'ns1.home.arpa' });
        const server = await createTechnitiumServer(world);
        await server.start(port);
        servers = [server];
        names = ['ns1.home.arpa'];
    }

    console.log('\nPaste this into config.yml, or save it and start the dashboard with it:\n');
    console.log('  node backend/src/server.js --config <file>\n');
    console.log(yaml.dump(mockConfig(servers, names), { lineWidth: -1 }));
    console.log('\nRunning. Press Ctrl-C to stop.\n');

    const stop = async () => {
        await Promise.all(servers.map(server => server.stop()));
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}

if (require.main === module) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { mockConfig };
