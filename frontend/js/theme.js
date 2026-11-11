/**
 * The theme on the page.
 *
 * This is a plain script in the head, not a module: modules are deferred and
 * would run after the page had already been painted, and the first paint has
 * to be in the right colours. app.js drives the switching and reads the same
 * values from here.
 */
(function () {
    const KEY = 'tdns-theme';
    const systemScheme = window.matchMedia('(prefers-color-scheme: light)');

    window.TdnsTheme = {
        saved: () => localStorage.getItem(KEY) || 'system',
        save: theme => localStorage.setItem(KEY, theme),
        // The system theme leaves the attribute off, so the stylesheet decides
        // the colours from the operating system preference.
        apply: theme => {
            const root = document.documentElement;
            if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
            else root.removeAttribute('data-theme');
        },
        // The system preference can change while the page is open.
        onSystemChange: handler => systemScheme.addEventListener('change', handler),
    };

    window.TdnsTheme.apply(window.TdnsTheme.saved());
})();
