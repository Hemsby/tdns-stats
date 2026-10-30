'use strict';

// Debug logging is opt-in and off by default. Enable it from the browser
// console with Log.enable(); the choice is remembered across reloads.
const Log = (() => {
    const KEY = 'tdns-stats-debug';

    function isEnabled() {
        try {
            return localStorage.getItem(KEY) === '1';
        } catch (e) {
            return false;
        }
    }

    function debug(...args) {
        if (isEnabled()) console.log(...args);
    }

    function enable() {
        try { localStorage.setItem(KEY, '1'); } catch (e) {}
        console.info('[log] debug logging enabled');
    }

    function disable() {
        try { localStorage.removeItem(KEY); } catch (e) {}
        console.info('[log] debug logging disabled');
    }

    return { debug, enable, disable, isEnabled };
})();
