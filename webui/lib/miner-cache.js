// Persistent cache for worker -> miner type mappings and best difficulties
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../data/miner-types.json');
const CKPOOL_LOGS_DIR = process.env.CKPOOL_LOGS_DIR || '/var/log/ckpool';

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
            const cache = JSON.parse(data);
            // Backwards compatibility: ensure required fields exist
            if (!cache.bestDiffs) cache.bestDiffs = {};
            if (!cache.lastSeenAt) cache.lastSeenAt = {};
            return cache;
        }
    } catch (err) {
        console.error('Failed to load miner cache:', err.message);
    }
    return { workers: {}, users: {}, bestDiffs: {}, lastSeenAt: {} };
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

    const now = Math.floor(Date.now() / 1000);

    clients.forEach(client => {
        if (!client.workername) return;

        // Track lastSeen for all connected workers regardless of useragent
        cache.lastSeenAt[client.workername] = now;
        updated = true;

        if (client.useragent) {
            const minerInfo = parseMinerType(client.useragent);
            const user = client.workername.split('.')[0];

            // Update worker -> miner type
            if (cache.workers[client.workername] !== minerInfo.name) {
                cache.workers[client.workername] = minerInfo.name;
            }

            // Update user -> miner type (keeps latest)
            if (user) {
                cache.users[user] = minerInfo.name;
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

// Update best difficulty for workers (only saves if higher)
function updateBestDiffs(workers, cache) {
    if (!workers || !Array.isArray(workers)) return cache;
    if (!cache) cache = loadCache();

    let updated = false;
    const now = Math.floor(Date.now() / 1000);

    workers.forEach(worker => {
        const fullName = worker.worker || worker.workername || '';
        if (!fullName) return;

        // Track lastSeen for every worker we see from ckpool
        cache.lastSeenAt[fullName] = now;
        updated = true;

        // Get all possible best diff values from ckpool
        const currentBest = Math.max(
            worker.bestever || 0,
            worker.bestshare || 0,
            worker.bestdiff || 0
        );

        if (currentBest > 0) {
            const storedBest = cache.bestDiffs[fullName] || 0;

            // Only update if new value is higher
            if (currentBest > storedBest) {
                cache.bestDiffs[fullName] = currentBest;
                console.log(`New best diff for ${fullName.split('.').slice(1).join('.') || 'anon'}: ${currentBest} (was ${storedBest})`);
            }
        }
    });

    if (updated) {
        saveCache(cache);
    }

    return cache;
}

// Get best difficulty for a worker (from cache or provided value)
function getBestDiff(fullName, currentBest, cache) {
    if (!cache) cache = loadCache();

    const storedBest = cache.bestDiffs[fullName] || 0;

    // Return the maximum of stored and current
    return Math.max(storedBest, currentBest || 0);
}

// Read best difficulty from ckpool worker files (most accurate source)
function readBestDiffFromCkpoolFile(workerName) {
    try {
        // Worker files are in /var/log/ckpool/users/<btc_address>/workers/<workername>
        // or /var/log/ckpool/users/<btc_address>.<workername>
        // The exact path depends on ckpool configuration

        const usersDir = path.join(CKPOOL_LOGS_DIR, 'users');
        if (!fs.existsSync(usersDir)) {
            return 0;
        }

        // Parse worker name: btcAddress.workerName or just btcAddress
        const parts = workerName.split('.');
        const btcAddress = parts[0];
        const workerSuffix = parts.slice(1).join('.') || '';

        // Try to find the worker file
        // Path format: /var/log/ckpool/users/<btcAddress>.<workerName>
        const workerFile = workerSuffix
            ? path.join(usersDir, `${btcAddress}.${workerSuffix}`)
            : path.join(usersDir, btcAddress);

        if (fs.existsSync(workerFile)) {
            const content = fs.readFileSync(workerFile, 'utf8');

            // Parse the file - it's typically JSON-like with key: value format
            // Look for bestever or bestshare
            const besteverMatch = content.match(/["']?bestever["']?\s*[:=]\s*([\d.]+)/i);
            const bestshareMatch = content.match(/["']?bestshare["']?\s*[:=]\s*([\d.]+)/i);

            const bestever = besteverMatch ? parseFloat(besteverMatch[1]) : 0;
            const bestshare = bestshareMatch ? parseFloat(bestshareMatch[1]) : 0;

            return Math.max(bestever, bestshare);
        }

        return 0;
    } catch (err) {
        console.error(`Error reading ckpool file for ${workerName}:`, err.message);
        return 0;
    }
}

// Scan all ckpool worker files to get best difficulties
function scanCkpoolBestDiffs() {
    const bestDiffs = {};

    try {
        const usersDir = path.join(CKPOOL_LOGS_DIR, 'users');
        if (!fs.existsSync(usersDir)) {
            console.log('CKPool users directory not found:', usersDir);
            return bestDiffs;
        }

        const files = fs.readdirSync(usersDir);

        for (const file of files) {
            const filePath = path.join(usersDir, file);
            const stat = fs.statSync(filePath);

            // Skip directories, only process worker files
            if (stat.isDirectory()) continue;

            try {
                const content = fs.readFileSync(filePath, 'utf8');

                // Parse bestever and bestshare from file content
                const besteverMatch = content.match(/["']?bestever["']?\s*[:=]\s*([\d.]+)/i);
                const bestshareMatch = content.match(/["']?bestshare["']?\s*[:=]\s*([\d.]+)/i);

                const bestever = besteverMatch ? parseFloat(besteverMatch[1]) : 0;
                const bestshare = bestshareMatch ? parseFloat(bestshareMatch[1]) : 0;
                const best = Math.max(bestever, bestshare);

                if (best > 0) {
                    bestDiffs[file] = best;
                }
            } catch (readErr) {
                // Skip files that can't be read
            }
        }

        console.log(`Scanned ${Object.keys(bestDiffs).length} worker files from ckpool logs`);
    } catch (err) {
        console.error('Error scanning ckpool logs:', err.message);
    }

    return bestDiffs;
}

// Get best difficulty using all available sources
function getBestDiffFromAllSources(fullName, currentBest, cache) {
    if (!cache) cache = loadCache();

    // Source 1: Our persistent cache
    const cachedBest = cache.bestDiffs[fullName] || 0;

    // Source 2: Current value from API (bestever/bestshare/bestdiff)
    const apiBest = currentBest || 0;

    // Source 3: Read directly from ckpool worker file
    const fileBest = readBestDiffFromCkpoolFile(fullName);

    // Return the maximum from all sources
    const maxBest = Math.max(cachedBest, apiBest, fileBest);

    // Update in-memory cache if we found a higher value (caller is responsible for saving)
    if (maxBest > cachedBest) {
        cache.bestDiffs[fullName] = maxBest;
    }

    return maxBest;
}

// Remove leaderboard entries for workers inactive longer than maxAgeDays.
// Workers with no lastSeenAt timestamp (old cache entries) are kept until they're seen once.
function pruneInactiveWorkers(maxAgeDays = 28) {
    const cache = loadCache();
    const cutoff = Math.floor(Date.now() / 1000) - (maxAgeDays * 86400);
    let pruned = 0;

    for (const name of Object.keys(cache.bestDiffs)) {
        const lastSeen = cache.lastSeenAt[name] || 0;
        if (lastSeen > 0 && lastSeen < cutoff) {
            delete cache.bestDiffs[name];
            delete cache.workers[name];
            delete cache.lastSeenAt[name];
            pruned++;
        }
    }

    if (pruned > 0) {
        saveCache(cache);
        console.log(`Pruned ${pruned} workers inactive >${maxAgeDays} days from leaderboard cache`);
    }

    return pruned;
}

module.exports = {
    loadCache,
    saveCache,
    updateFromClients,
    getMinerType,
    updateBestDiffs,
    getBestDiff,
    getBestDiffFromAllSources,
    pruneInactiveWorkers,
    scanCkpoolBestDiffs,
    readBestDiffFromCkpoolFile
};
