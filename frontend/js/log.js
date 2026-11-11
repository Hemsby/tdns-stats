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
        try {
            localStorage.setItem(KEY, '1');
        } catch (e) {}
        console.info('[log] debug logging enabled');
    }

    function disable() {
        try {
            localStorage.removeItem(KEY);
        } catch (e) {}
        console.info('[log] debug logging disabled');
    }

    return { debug, enable, disable, isEnabled };
})();

// Kept on the window so the debug switch stays reachable from the browser
// console (Log.enable()), the same way it was before this file became a module.
if (typeof window !== 'undefined') window.Log = Log;

export { Log };
