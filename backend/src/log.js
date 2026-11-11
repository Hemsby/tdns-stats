'use strict';

/**
 * Debug logging for the backend.
 *
 * Debug logging is opt-in. Enable it with `debug: true` in config.yml.
 * Everything logged through log.debug() is silent unless enabled.
 */
let enabled = false;

function configure(configDebug) {
    enabled = configDebug === true;
}

function debug(...args) {
    if (enabled) console.log(...args);
}

module.exports = { configure, debug };
