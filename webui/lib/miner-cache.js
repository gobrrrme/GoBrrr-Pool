// Simple persistent cache for worker -> miner type mappings
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../data/miner-types.json');

// Ensure data directory exists
function ensureDataDir() {
    const dataDir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

// Load cache from file
function loadCache() {
    try {
        ensureDataDir();
        if (fs.existsSync(CACHE_FILE)) {
            const data = fs.readFileSync(CACHE_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error('Failed to load miner cache:', err.message);
    }
    return { workers: {}, users: {} };
}

// Save cache to file
function saveCache(cache) {
    try {
        ensureDataDir();
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch (err) {
        console.error('Failed to save miner cache:', err.message);
    }
}

// Update cache with new client data
function updateFromClients(clients, parseMinerType) {
    if (!clients || !Array.isArray(clients)) return;

    const cache = loadCache();
    let updated = false;

    clients.forEach(client => {
        if (client.workername && client.useragent) {
            const minerInfo = parseMinerType(client.useragent);
            const user = client.workername.split('.')[0];

            // Update worker -> miner type
            if (cache.workers[client.workername] !== minerInfo.name) {
                cache.workers[client.workername] = minerInfo.name;
                updated = true;
            }

            // Update user -> miner type (keeps latest)
            if (user) {
                cache.users[user] = minerInfo.name;
                updated = true;
            }
        }
    });

    if (updated) {
        saveCache(cache);
    }

    return cache;
}

// Get miner type for a worker (with fallbacks)
function getMinerType(fullName, cache) {
    if (!cache) cache = loadCache();

    // Try exact worker match
    if (cache.workers[fullName]) {
        return cache.workers[fullName];
    }

    // Try user (BTC address) match
    const user = fullName.split('.')[0];
    if (user && cache.users[user]) {
        return cache.users[user];
    }

    return 'Unknown';
}

module.exports = {
    loadCache,
    saveCache,
    updateFromClients,
    getMinerType
};
