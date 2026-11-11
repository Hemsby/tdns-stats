'use strict';

const http = require('node:http');
const server = require('../../src/server');

/**
 * The app with a mock poller and updater, so the routes can be driven without
 * a Technitium server and without a fixed port.
 *
 * The server URL points at a port nothing listens on: the routes that talk to
 * Technitium then fail immediately instead of waiting on a DNS timeout.
 */
function makeApp(options = {}) {
    server.setConfig({
        port: 3000,
        servers: [{ name: 'ns1', url: 'http://127.0.0.1:1', token: 't' }],
        ...options.config,
    });
    server.__resetState();

    const calls = [];
    const poller = {
        getState: () => options.state ?? { nodes: {}, top: {}, perf: {}, rttSeries: {} },
        pause: () => calls.push('pause'),
        resume: async () => calls.push('resume'),
        refreshRangeData: () => calls.push('refreshRangeData'),
        setWatchedServer: name => calls.push(`watch:${name}`),
    };

    const updater = options.updater || { capable: false, executeUpdate: async () => 'updated' };

    return { app: server.createApp(poller, updater), calls, poller, updater };
}

/**
 * The app listening on an ephemeral port, with a small client for it.
 */
async function listen(app) {
    const srv = app.listen(0, '127.0.0.1');
    await new Promise(resolve => srv.once('listening', resolve));
    const port = srv.address().port;

    const call = async (method, path, headers = {}) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
        const text = await res.text();
        let body = null;
        try {
            body = JSON.parse(text);
        } catch (_) {
            /* not JSON */
        }
        return { status: res.status, body, headers: res.headers };
    };

    return {
        port,
        get: (path, headers) => call('GET', path, headers),
        post: (path, headers) => call('POST', path, headers),
        /** Create a session and return its cookie. */
        async cookie() {
            const res = await call('GET', '/api/session');
            return res.headers.get('set-cookie').split(';')[0];
        },
        close() {
            // An open event stream would keep the server alive forever.
            srv.closeAllConnections();
            return new Promise(resolve => srv.close(resolve));
        },
    };
}

/**
 * Open the event stream and collect what the server sends.
 *
 * The stream never ends, so the promise resolves as soon as the response
 * headers arrive and the chunks are collected in the background.
 */
function openStream(port, cookie) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: '/api/stream',
            headers: { cookie },
        });
        const chunks = [];
        req.on('response', res => {
            res.setEncoding('utf8');
            res.on('data', chunk => chunks.push(chunk));
            resolve({ req, text: () => chunks.join('') });
        });
        req.on('error', err => {
            // Destroying the request is how a test closes the stream.
            if (err.code !== 'ECONNRESET') reject(err);
        });
        req.end();
    });
}

module.exports = { makeApp, listen, openStream };
