'use strict';

const Charts = (() => {
    let chart = null;
    let lastView = null;
    const hiddenByView = { overview: new Set(), all: new Set() };
    let persistCallback = null;

    // Map dataset labels to CSS variable names so chart colors follow the UI theme
    const DATASET_COLORS = {
        'Total':          { borderVar: '--accent-blue',  bgVar: '--accent-blue-bg' },
        'No Error':       { borderVar: '--accent-green', bgVar: '--accent-green-bg' },
        'Blocked':        { borderVar: '--accent-red',   bgVar: '--accent-red-bg' },
        'Cached':         { borderVar: '--accent-teal',  bgVar: '--accent-teal-bg' },
        'Recursive':      { borderVar: '--accent-pur',   bgVar: '--accent-pur-bg' },
        'Authoritative':  { borderVar: '--accent-yel',   bgVar: '--accent-yel-bg' },
        'NX Domain':      { borderVar: '--accent-ora',   bgVar: '--accent-ora-bg' },
        'Server Failure': { borderVar: '--accent-red',   bgVar: '--accent-red-bg' },
        'Dropped':        { borderVar: '--accent-slate' },
        'Clients':        { borderVar: '--accent-pur',   bgVar: '--accent-pur-bg' },
        'Refused':        { borderVar: '--accent-slate' },
    };

    function cssVar(name) {
        try {
            return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || null;
        } catch (e) {
            return null;
        }
    }

    function hexToRgba(hex, alpha) {
        if (!hex) return null;
        const h = hex.replace('#', '');
        if (h.length === 3) {
            const r = parseInt(h[0] + h[0], 16);
            const g = parseInt(h[1] + h[1], 16);
            const b = parseInt(h[2] + h[2], 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        if (h.length === 6) {
            const r = parseInt(h.slice(0,2), 16);
            const g = parseInt(h.slice(2,4), 16);
            const b = parseInt(h.slice(4,6), 16);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        return null;
    }

    function resolveColor(entry) {
        // entry may have borderVar and bgVar
        const border = entry.borderVar ? cssVar(entry.borderVar) : null;
        let bg = entry.bgVar ? cssVar(entry.bgVar) : null;

        if (!bg) {
            // Try to synthesize a translucent background from the border color
            if (border && border.startsWith('rgb(')) {
                bg = border.replace('rgb(', 'rgba(').replace(')', ', .08)');
            } else if (border && border.startsWith('#')) {
                bg = hexToRgba(border, 0.08) || 'rgba(139,148,158,.08)';
            }
        }

        return { border: border || entry.border || '#8b949e', bg: bg || entry.bg || 'rgba(139,148,158,.08)' };
    }

    const OVERVIEW_DATASETS = ['Total', 'Blocked', 'Cached', 'Recursive'];

    function setPersistCallback(callback) {
        persistCallback = callback;
    }

    function init() {
        const canvas = document.getElementById('mainChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        chart = new Chart(ctx, {
            type: 'line',
            data: { labels: [], datasets: [] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 300 },
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            color: '#94a3b8', boxWidth: 12, padding: 16, font: { size: 11 }
                        },
                        onClick: (e, legendItem, legend) => {
                            const index = legendItem.datasetIndex;
                            const dataset = chart.data.datasets[index];
                            const meta = chart.getDatasetMeta(index);

                            meta.hidden = !meta.hidden;

                            if (meta.hidden) {
                                hiddenByView[lastView || 'overview'].add(dataset.label);
                            } else {
                                hiddenByView[lastView || 'overview'].delete(dataset.label);
                            }

                            if (persistCallback) {
                                persistCallback(lastView || 'overview', hiddenByView[lastView || 'overview']);
                            }

                            chart.update('none');
                        }
                    },
                    tooltip: {
                        backgroundColor: '#0b1222',
                        borderColor: 'rgba(34,211,238,.2)',
                        borderWidth: 1,
                        titleColor: '#e2e8f0',
                        bodyColor: '#94a3b8',
                        callbacks: {
                            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y}`
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: { color: '#475569', font: { size: 10 }, maxTicksLimit: 12 },
                        grid: { color: 'rgba(34,211,238,.06)' }
                    },
                    y: {
                        ticks: { color: '#475569', font: { size: 10 } },
                        grid: { color: 'rgba(34,211,238,.06)' },
                        beginAtZero: true
                    }
                }
            }
        });
    }

    function update(nodeData, serverName, datasetMode) {
        if (!chart) init();
        if (!chart) return;
        const node = nodeData[serverName];
        const chartData = node?.stats?.mainChartData;
        if (!chartData) return;
        updateFromData(chartData, datasetMode);
    }

    function formatLabels(labels, fmt, tzOffset) {
        if (!fmt || !labels?.length) return labels;
        const utc = !tzOffset && !/HH|mm/.test(fmt);
        return labels.map(l => {
            if (typeof l !== 'string') return l;
            const d = new Date(l);
            if (isNaN(d.getTime())) return l;
            const pad = n => String(n).padStart(2, '0');
            const part = n => utc ? d['getUTC' + n]() : d['get' + n]();
            return fmt
                .replace(/yyyy|YYYY/g, part('FullYear'))
                .replace(/dd|DD/g, pad(part('Date')))
                .replace(/HH/g, pad(part('Hours')))
                .replace(/mm/g, pad(part('Minutes')))
                .replace(/MM/g, pad(part('Month') + 1));
        });
    }

    function updateFromData(responseOrChartData, datasetMode) {
        if (!chart) init();
        if (!chart) return;
        // Accept either the raw API response object or just mainChartData directly
        const chartData = responseOrChartData?.mainChartData || responseOrChartData;
        if (!chartData?.labels) return;

        // Preserve hidden label state across polling updates
        if (lastView && chart.data.datasets.length > 0) {
            const currentSet = hiddenByView[lastView];

            if (currentSet) {
                currentSet.clear();

                for (let i = 0; i < chart.data.datasets.length; i++) {
                    if (!chart.isDatasetVisible(i)) {
                        currentSet.add(chart.data.datasets[i].label);
                    }
                }
            }
        }

        // If view mode changed, load saved state for the new view
        if (lastView !== datasetMode && hiddenByView[datasetMode].size === 0) {
            // Only load if we haven't already populated this view
            if (typeof loadChartHiddenState !== 'undefined') {
                hiddenByView[datasetMode] = loadChartHiddenState(datasetMode);
            }
        }

        lastView = datasetMode;

        const showAll = datasetMode === 'all';
        const allowed = new Set(showAll ? Object.keys(DATASET_COLORS) : OVERVIEW_DATASETS);

        const datasets = (chartData.datasets || [])
            .filter(ds => allowed.has(ds.label))
            .map(ds => {
                const entry = DATASET_COLORS[ds.label] || { border: '#8b949e', bg: 'rgba(139,148,158,.08)' };
                const c = resolveColor(entry);
                return {
                    label:            ds.label,
                    data:             ds.data,
                    borderColor:      c.border,
                    backgroundColor:  c.bg,
                    borderWidth:      1.5,
                    pointRadius:      0,
                    pointHoverRadius: 4,
                    fill:             false,
                    tension:          0.3,
                };
            });

        chart.data.labels   = formatLabels(chartData.labels, chartData.labelFormat, chartData.tzOffset);
        chart.data.datasets = datasets;

        // Restore hidden label state after update
        const hidden = hiddenByView[datasetMode];
        if (hidden) {
            for (let i = 0; i < chart.data.datasets.length; i++) {
                chart.getDatasetMeta(i).hidden = hidden.has(chart.data.datasets[i].label);
            }
        }

        chart.update('none');

        // Persist current state after update
        if (persistCallback) {
            persistCallback(datasetMode, hiddenByView[datasetMode]);
        }
    }

    function setLoadCallback(loadFn) {
        // Store the load function for use when view mode changes
        window.loadChartHiddenState = loadFn;
    }

    return { init, update, updateFromData, setPersistCallback, setLoadCallback };
})();
