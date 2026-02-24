// CKPool Solo WebUI - Main JavaScript

// Tab Navigation
function initTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;

            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            tabContents.forEach(content => {
                content.classList.remove('active');
                if (content.id === `tab-${tabId}`) {
                    content.classList.add('active');
                }
            });
        });
    });
}

// Load Bitcoin Hero Data
async function loadBitcoinHeroData() {
    try {
        // Load network stats and price in parallel (use secureFetch for protected API)
        const [networkRes, priceRes] = await Promise.all([
            window.secureFetch('/api/network'),
            window.secureFetch('/api/price')
        ]);

        const networkData = await networkRes.json();
        const priceData = await priceRes.json();

        if (networkData.success && networkData.data) {
            const data = networkData.data;

            // Hero stats - show last mined block (ckpool reports next block, so subtract 1)
            updateElement('hero-block-height', data.blockHeight ? data.blockHeight - 1 : '-');
            updateElement('hero-network-hashrate', formatHashrate(data.networkHashrate));
            updateElement('hero-difficulty', formatDifficulty(data.difficulty));

            // Last block info
            updateElement('hero-last-miner', data.lastBlockMiner || 'Unknown');
            updateElement('hero-block-time', data.lastBlockTime ? timeAgo(data.lastBlockTime) : '-');

            // Mempool & fees
            updateElement('hero-mempool', formatBytes(data.mempool?.size || 0));
            updateElement('hero-mempool-txs', (data.mempool?.count || 0).toLocaleString());
            updateElement('hero-avg-fee', (data.fees?.hour || 0) + ' sat/vB');

            // Difficulty adjustment
            if (data.difficultyAdjustment) {
                const adj = data.difficultyAdjustment;
                const sign = adj.difficultyChange >= 0 ? '+' : '';
                updateElement('hero-next-diff', `${sign}${adj.difficultyChange?.toFixed(2)}% (${adj.remainingBlocks} blocks)`);
            }

            // Fee rates
            updateElement('fee-no-priority', data.fees?.minimum || '-');
            updateElement('fee-low', data.fees?.economy || '-');
            updateElement('fee-medium', data.fees?.hour || '-');
            updateElement('fee-high', data.fees?.fastest || '-');

            // Recent blocks
            renderRecentBlocks(data.recentBlocks || []);
        }

        if (priceData.success && priceData.data) {
            updateElement('hero-btc-price', '$' + (priceData.data.USD?.toLocaleString() || '-'));
        }

    } catch (err) {
        console.error('Failed to load Bitcoin hero data:', err);
    }
}

// Render recent blocks list
function renderRecentBlocks(blocks) {
    const container = document.getElementById('recent-blocks-list');
    if (!container || !blocks.length) return;

    container.innerHTML = blocks.map(block => `
        <div class="block-item">
            <span class="block-height">#${block.height}</span>
            <span class="block-miner">${block.miner}</span>
            <span class="block-hash">${truncateHash(block.hash)}</span>
            <span class="block-txs">${block.txCount} txs</span>
            <span class="block-time">${timeAgo(block.time)}</span>
        </div>
    `).join('');
}

// Truncate block hash
function truncateHash(hash) {
    if (!hash) return '';
    return hash.slice(0, 8) + '...' + hash.slice(-8);
}

// Legacy function for backwards compatibility
async function loadNetworkData() {
    return loadBitcoinHeroData();
}

// Update DOM element
function updateElement(id, value) {
    const el = document.getElementById(id);
    if (el) {
        el.textContent = value;
    }
}

// Format hashrate
function formatHashrate(hashesPerSecond) {
    if (!hashesPerSecond || hashesPerSecond === 0) return '0 H/s';

    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s', 'ZH/s'];
    let unitIndex = 0;
    let value = hashesPerSecond;

    while (value >= 1000 && unitIndex < units.length - 1) {
        value /= 1000;
        unitIndex++;
    }

    return `${value.toFixed(2)} ${units[unitIndex]}`;
}

// Format difficulty
function formatDifficulty(diff) {
    if (!diff) return '0';

    if (diff >= 1e15) return (diff / 1e15).toFixed(2) + ' P';
    if (diff >= 1e12) return (diff / 1e12).toFixed(2) + ' T';
    if (diff >= 1e9) return (diff / 1e9).toFixed(2) + ' G';
    if (diff >= 1e6) return (diff / 1e6).toFixed(2) + ' M';
    if (diff >= 1e3) return (diff / 1e3).toFixed(2) + ' K';

    return diff.toFixed(2);
}

// Format bytes
function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 vB';

    const units = ['vB', 'KvB', 'MvB', 'GvB'];
    let unitIndex = 0;
    let value = bytes;

    while (value >= 1000 && unitIndex < units.length - 1) {
        value /= 1000;
        unitIndex++;
    }

    return `${value.toFixed(2)} ${units[unitIndex]}`;
}

// Time ago
function timeAgo(timestamp) {
    if (!timestamp) return 'Never';

    const seconds = Math.floor(Date.now() / 1000 - timestamp);

    if (seconds < 0) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

// Recent Searches
const RECENT_SEARCHES_KEY = 'ckpool_recent_searches';
const MAX_RECENT_SEARCHES = 5;
const RECENT_SEARCHES_TTL = 48 * 60 * 60 * 1000; // 48 hours in milliseconds

function loadRecentSearches() {
    const chips = document.getElementById('lookup-chips');
    if (!chips) return;

    const searches = getRecentSearches();
    chips.innerHTML = searches.map(item => `
        <span class="lookup-chip">
            <a href="/stats/${item.address}" class="lookup-chip-addr">${truncateAddress(item.address)}</a>
            <button class="lookup-chip-del" onclick="event.preventDefault();removeRecentSearch('${item.address}')" title="Remove">&times;</button>
        </span>
    `).join('');
}

function removeRecentSearch(address) {
    let searches = getRecentSearches();
    searches = searches.filter(item => item.address !== address);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(searches));
    loadRecentSearches();
}

function getRecentSearches() {
    try {
        const now = Date.now();
        let searches = JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY)) || [];

        // Migrate old format (plain strings) to new format (objects with timestamp)
        if (searches.length > 0 && typeof searches[0] === 'string') {
            searches = searches.map(addr => ({ address: addr, timestamp: now }));
            localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(searches));
        }

        // Filter out entries older than 48h
        searches = searches.filter(item => (now - item.timestamp) < RECENT_SEARCHES_TTL);

        // Save filtered list back to localStorage
        localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(searches));

        return searches;
    } catch {
        return [];
    }
}

function saveRecentSearch(address) {
    let searches = getRecentSearches();
    searches = searches.filter(item => item.address !== address);
    searches.unshift({ address: address, timestamp: Date.now() });
    searches = searches.slice(0, MAX_RECENT_SEARCHES);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(searches));
}

function truncateAddress(addr) {
    if (addr.length <= 20) return addr;
    return addr.slice(0, 10) + '...' + addr.slice(-8);
}

// Hashrate Chart
function initHashrateChart(data, chartId = 'hashrate-chart') {
    const ctx = document.getElementById(chartId);
    if (!ctx) return null;

    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => d.label),
            datasets: [{
                label: 'Hashrate',
                data: data.map(d => d.value),
                borderColor: '#ff931c',
                backgroundColor: 'rgba(255, 147, 28, 0.1)',
                fill: true,
                tension: 0.4,
                pointBackgroundColor: '#ff931c',
                pointBorderColor: '#212121',
                pointRadius: 6,
                pointHoverRadius: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#212121',
                    titleColor: '#c4c4c4',
                    bodyColor: '#ff931c',
                    borderColor: '#000000',
                    borderWidth: 2,
                    callbacks: {
                        label: function(context) {
                            return formatHashrate(context.raw);
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(196, 196, 196, 0.1)' },
                    ticks: {
                        color: '#b0b0b0',
                        callback: function(value) {
                            return formatHashrate(value);
                        }
                    }
                },
                x: {
                    grid: { color: 'rgba(196, 196, 196, 0.1)' },
                    ticks: { color: '#b0b0b0' }
                }
            }
        }
    });
}

// Address form handling
document.addEventListener('DOMContentLoaded', function() {
    const form = document.getElementById('address-form');
    if (form) {
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            const address = document.getElementById('btc-address').value.trim();
            if (address) {
                window.location.href = `/stats/${address}`;
            }
        });
    }

    // Initialize drag-and-drop
    initDragAndDrop();
});

// ===========================================
// DRAG AND DROP FUNCTIONALITY
// ===========================================

const LAYOUT_STORAGE_KEY = 'gobrrrpool_layout_';

// Create drag handle element
function createDragHandle(isSection = false) {
    const handle = document.createElement('div');
    handle.className = isSection ? 'section-drag-handle' : 'drag-handle';
    handle.innerHTML = '<span></span><span></span><span></span>';
    handle.title = 'Drag to reorder';
    return handle;
}

// Get page identifier for storage
function getPageId() {
    const path = window.location.pathname;
    if (path === '/') return 'home';
    if (path === '/pool') return 'pool';
    if (path === '/dashboard') return 'dashboard';
    if (path.startsWith('/stats/')) return 'stats';
    return 'other';
}

// Save layout to localStorage
function saveLayout(containerId, order) {
    const key = LAYOUT_STORAGE_KEY + getPageId() + '_' + containerId;
    localStorage.setItem(key, JSON.stringify(order));
}

// Load layout from localStorage
function loadLayout(containerId) {
    const key = LAYOUT_STORAGE_KEY + getPageId() + '_' + containerId;
    try {
        return JSON.parse(localStorage.getItem(key)) || null;
    } catch {
        return null;
    }
}

// Apply saved layout
function applyLayout(container, savedOrder) {
    if (!savedOrder || !container) return;

    const children = Array.from(container.children);
    const orderedChildren = [];

    // Reorder based on saved order
    savedOrder.forEach(id => {
        const child = children.find(c => c.dataset.sortId === id);
        if (child) orderedChildren.push(child);
    });

    // Add any children not in saved order (new elements)
    children.forEach(child => {
        if (!orderedChildren.includes(child)) {
            orderedChildren.push(child);
        }
    });

    // Re-append in order
    orderedChildren.forEach(child => container.appendChild(child));
}

// Initialize drag and drop for the page
function initDragAndDrop() {
    if (typeof Sortable === 'undefined') {
        console.warn('SortableJS not loaded');
        return;
    }

    const pageId = getPageId();

    // Pool Stats page - vertical sections only
    if (pageId === 'pool') {
        initPoolPageDragDrop();
        return;
    }

    // Stats page - sections only
    if (pageId === 'stats') {
        initStatsPageDragDrop();
        return;
    }

    // Dashboard page
    if (pageId === 'dashboard') {
        initDashboardDragDrop();
        return;
    }

    // Home page
    if (pageId === 'home') {
        initHomePageDragDrop();
        return;
    }
}

// Home page: sections sorting
function initHomePageDragDrop() {
    const homeSections = document.querySelector('.home-sections');
    if (!homeSections) return;

    const sections = homeSections.querySelectorAll('.home-section');
    sections.forEach((section, index) => {
        section.dataset.sortId = 'section-' + index;
        section.appendChild(createDragHandle(true));
    });

    // Apply saved layout
    applyLayout(homeSections, loadLayout('home-sections'));

    // Make sections sortable
    new Sortable(homeSections, {
        handle: '.section-drag-handle',
        animation: 200,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        onEnd: function() {
            const order = Array.from(homeSections.querySelectorAll('.home-section'))
                .map(s => s.dataset.sortId);
            saveLayout('home-sections', order);
        }
    });
}

// Pool page: vertical section sorting
function initPoolPageDragDrop() {
    const homeSections = document.querySelector('.home-sections');
    if (!homeSections) return;

    const sections = homeSections.querySelectorAll('.home-section');
    sections.forEach((section, index) => {
        section.dataset.sortId = 'section-' + index;
        section.appendChild(createDragHandle(true));
    });

    // Apply saved layout
    applyLayout(homeSections, loadLayout('pool-sections'));

    // Make sections sortable
    new Sortable(homeSections, {
        handle: '.section-drag-handle',
        animation: 200,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        onEnd: function() {
            const order = Array.from(homeSections.querySelectorAll('.home-section'))
                .map(s => s.dataset.sortId);
            saveLayout('pool-sections', order);
        }
    });
}

// Stats page: section sorting
function initStatsPageDragDrop() {
    const userStats = document.querySelector('.user-stats');
    if (!userStats) return;

    const sections = userStats.querySelectorAll('.stats-section');
    sections.forEach((section, index) => {
        section.dataset.sortId = 'section-' + index;
        section.appendChild(createDragHandle(true));
    });

    applyLayout(userStats, loadLayout('stats-sections'));

    new Sortable(userStats, {
        handle: '.section-drag-handle',
        animation: 200,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        onEnd: function() {
            const order = Array.from(userStats.querySelectorAll('.stats-section'))
                .map(s => s.dataset.sortId);
            saveLayout('stats-sections', order);
        }
    });
}

// Dashboard page: section sorting
function initDashboardDragDrop() {
    const homeSections = document.querySelector('.home-sections');
    if (!homeSections) return;

    const sections = homeSections.querySelectorAll('.home-section');
    sections.forEach((section, index) => {
        section.dataset.sortId = 'section-' + index;
        section.appendChild(createDragHandle(true));
    });

    // Apply saved layout
    applyLayout(homeSections, loadLayout('dashboard-sections'));

    // Make sections sortable
    new Sortable(homeSections, {
        handle: '.section-drag-handle',
        animation: 200,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        onEnd: function() {
            const order = Array.from(homeSections.querySelectorAll('.home-section'))
                .map(s => s.dataset.sortId);
            saveLayout('dashboard-sections', order);
        }
    });
}
