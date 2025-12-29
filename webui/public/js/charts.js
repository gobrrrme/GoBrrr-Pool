// CKPool Solo WebUI - Chart.js Configuration (Updated for new design)

// Chart colors matching the reference design
const chartColors = {
    primary: '#ff931c',
    primaryLight: 'rgba(255, 147, 28, 0.2)',
    secondary: '#00d26a',
    secondaryLight: 'rgba(0, 210, 106, 0.2)',
    grid: 'rgba(196, 196, 196, 0.1)',
    text: '#b0b0b0',
    textLight: '#c4c4c4'
};

// Default chart options
const defaultChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
        legend: {
            labels: {
                color: chartColors.text,
                font: {
                    family: "'Segoe UI', system-ui, sans-serif",
                    weight: '500'
                }
            }
        }
    },
    scales: {
        y: {
            beginAtZero: true,
            grid: {
                color: chartColors.grid
            },
            ticks: {
                color: chartColors.text,
                font: {
                    family: "'Segoe UI', system-ui, sans-serif"
                }
            }
        },
        x: {
            grid: {
                color: chartColors.grid
            },
            ticks: {
                color: chartColors.text,
                font: {
                    family: "'Segoe UI', system-ui, sans-serif"
                }
            }
        }
    }
};

// Create hashrate chart
function createHashrateChart(ctx, labels, data) {
    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Hashrate',
                data: data,
                borderColor: chartColors.primary,
                backgroundColor: chartColors.primaryLight,
                fill: true,
                tension: 0.4,
                pointBackgroundColor: chartColors.primary,
                pointBorderColor: '#212121',
                pointBorderWidth: 2,
                pointRadius: 6,
                pointHoverRadius: 8
            }]
        },
        options: {
            ...defaultChartOptions,
            plugins: {
                ...defaultChartOptions.plugins,
                tooltip: {
                    backgroundColor: '#212121',
                    titleColor: chartColors.textLight,
                    bodyColor: chartColors.primary,
                    borderColor: '#000000',
                    borderWidth: 2,
                    padding: 12,
                    cornerRadius: 8,
                    callbacks: {
                        label: function(context) {
                            return formatHashrate(context.raw);
                        }
                    }
                }
            },
            scales: {
                ...defaultChartOptions.scales,
                y: {
                    ...defaultChartOptions.scales.y,
                    ticks: {
                        ...defaultChartOptions.scales.y.ticks,
                        callback: function(value) {
                            return formatHashrate(value);
                        }
                    }
                }
            }
        }
    });
}

// Create shares chart (doughnut)
function createSharesChart(ctx, accepted, rejected, stale) {
    return new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Accepted', 'Rejected', 'Stale'],
            datasets: [{
                data: [accepted, rejected, stale],
                backgroundColor: [
                    chartColors.secondary,
                    '#ff6b6b',
                    chartColors.primary
                ],
                borderColor: '#212121',
                borderWidth: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        color: chartColors.text,
                        padding: 20,
                        font: {
                            family: "'Segoe UI', system-ui, sans-serif",
                            weight: '500'
                        }
                    }
                },
                tooltip: {
                    backgroundColor: '#212121',
                    titleColor: chartColors.textLight,
                    bodyColor: chartColors.primary,
                    borderColor: '#000000',
                    borderWidth: 2,
                    padding: 12,
                    cornerRadius: 8
                }
            }
        }
    });
}

// Create pool hashrate history chart
function createPoolHashrateChart(ctx, data) {
    const labels = data.map((_, i) => `${data.length - i}m ago`).reverse();
    const values = data.slice().reverse();

    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Pool Hashrate',
                data: values,
                borderColor: chartColors.primary,
                backgroundColor: chartColors.primaryLight,
                fill: true,
                tension: 0.3,
                pointBackgroundColor: chartColors.primary,
                pointBorderColor: '#212121',
                pointBorderWidth: 2
            }]
        },
        options: defaultChartOptions
    });
}
