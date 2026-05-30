'use strict';

const Charts = (() => {
    let chart = null;
    let lastView = null;
    const hiddenByView = { overview: new Set(), all: new Set() };
    let persistCallback = null;

    const DATASET_COLORS = {
        'Total':          { border: 'rgb(34,211,238)',   bg: 'rgba(34,211,238,.07)'   },
        'No Error':       { border: 'rgb(52,211,153)',   bg: 'rgba(52,211,153,.07)'   },
        'Blocked':        { border: 'rgb(248,113,113)',  bg: 'rgba(248,113,113,.07)'  },
        'Cached':         { border: 'rgb(45,212,191)',   bg: 'rgba(45,212,191,.07)'   },
        'Recursive':      { border: 'rgb(167,139,250)',  bg: 'rgba(167,139,250,.07)'  },
        'Authoritative':  { border: 'rgb(251,191,36)',   bg: 'rgba(251,191,36,.07)'   },
        'NX Domain':      { border: 'rgb(251,146,60)',   bg: 'rgba(251,146,60,.07)'   },
        'Server Failure': { border: 'rgb(248,113,113)',  bg: 'rgba(248,113,113,.09)'  },
        'Dropped':        { border: 'rgb(100,116,139)',  bg: 'rgba(100,116,139,.09)'  },
        'Clients':        { border: 'rgb(167,139,250)',  bg: 'rgba(167,139,250,.07)'  },
        'Refused':        { border: 'rgb(100,116,139)',  bg: 'rgba(100,116,139,.07)'  },
    };

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
                const c = DATASET_COLORS[ds.label] || { border: '#8b949e', bg: 'rgba(139,148,158,.08)' };
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

        chart.data.labels   = chartData.labels || [];
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
