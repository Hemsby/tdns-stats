const globals = require('globals');

// prettierConfig switches off every lint rule that would argue with
// Prettier about the layout of a line.
const prettierConfig = require('eslint-config-prettier');
const correctness = {
    'no-undef': 'error',
    'no-unused-vars': [
        'error',
        {
            argsIgnorePattern: '^_',
            caughtErrors: 'none',
            // Destructuring a key out of an object to leave it out of the rest is
            // how the code drops a field, and those names are meant to go unused.
            ignoreRestSiblings: true,
        },
    ],
    'no-var': 'error',
    'no-implicit-globals': 'error',
    eqeqeq: ['error', 'smart'],
};

module.exports = [
    {
        ignores: ['**/node_modules/**', 'backend/node_modules/**', 'frontend/node_modules/**'],
    },
    {
        files: ['backend/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: globals.node,
        },
        rules: { ...correctness, ...prettierConfig.rules },
    },
    {
        // The theme script is a plain script in the head so it runs before the
        // first paint. A module would be deferred and too late.
        files: ['frontend/js/theme.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: globals.browser,
        },
        rules: { ...correctness, ...prettierConfig.rules },
    },
    {
        files: ['frontend/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                // Loaded from a CDN in index.html.
                Chart: 'readonly',
                marked: 'readonly',
                // charts.js puts it on the window for the other modules.
                loadChartHiddenState: 'readonly',
                // theme.js puts it on the window for app.js.
                TdnsTheme: 'readonly',
            },
        },
        rules: { ...correctness, ...prettierConfig.rules },
    },
];
