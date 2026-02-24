const express = require('express');
const router = express.Router();
const ckpool = require('../lib/ckpool-client');
const { parseUserStats, parsePoolStats, parseClientInfo, aggregateMinerTypes, formatHashrate, formatDifficulty, timeAgo } = require('../lib/stats-parser');
const minerCache = require('../lib/miner-cache');

// Home page with tabs (General Info + Worker Lookup)
router.get('/', async (req, res) => {
    try {
        const poolStats = await ckpool.getPoolStats();
        const parsed = parsePoolStats(poolStats.poolstats, poolStats.stratifier, poolStats.connector);

        res.render('index', {
            pool: parsed,
            formatHashrate,
            formatDifficulty,
            stratumPort: process.env.STRATUM_PORT || 3333
        });
    } catch (err) {
        console.error('Error loading home page:', err);
        res.render('index', {
            pool: null,
            formatHashrate,
            formatDifficulty,
            stratumPort: process.env.STRATUM_PORT || 3333
        });
    }
});

// Stats page for specific BTC address
router.get('/stats/:address', async (req, res) => {
    const { address } = req.params;

    // Basic BTC address validation
    if (!address || !/^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,62}$/.test(address)) {
        return res.render('stats', {
            error: 'Invalid Bitcoin address',
            address,
            user: null,
            clients: [],
            formatHashrate,
            formatDifficulty,
            timeAgo
        });
    }

    try {
        // Fetch user stats and client info in parallel
        const [userStats, clientData] = await Promise.all([
            ckpool.getUserStats(address),
            ckpool.getUserClients(address)
        ]);

        if (process.env.NODE_ENV !== 'production') {
            console.log(`User stats for ${address}:`, JSON.stringify(userStats));
            console.log(`Client info for ${address}:`, JSON.stringify(clientData));
        }

        // parseUserStats returns null for invalid/unknown users
        const parsed = parseUserStats(userStats);
        const clients = parseClientInfo(clientData);

        // Fetch worker stats for each client to get accurate hashrate
        // (ucinfo doesn't always return correct dsps1 for all miner types like nmminer)
        if (clients.length > 0) {
            const workerStatsPromises = clients.map(client => {
                const parts = client.workername?.split('.') || [];
                // Only call getworker if there's an actual suffix (workername != address)
                const workerSuffix = parts.length > 1 ? parts.pop() : null;
                if (!workerSuffix) return Promise.resolve(null);
                return ckpool.getWorkerStats(address, workerSuffix).catch(() => null);
            });
            const workerStatsResults = await Promise.all(workerStatsPromises);

            // Update each client's dsps values with worker stats (worker-level aggregate,
            // more stable than per-connection ucinfo values)
            clients.forEach((client, index) => {
                const workerStats = workerStatsResults[index];
                if (workerStats && !workerStats.error && workerStats.dsps1 !== undefined) {
                    client.dsps1 = workerStats.dsps1;
                }
            });
        }

        // Check if user was not found or has no activity
        if (!parsed) {
            return res.render('stats', {
                error: null,
                address,
                user: null, // Will show "Address Not Found" message
                clients: [],
                formatHashrate,
                formatDifficulty,
                timeAgo
            });
        }

        // Enhance bestDiff with historical data from ckpool files
        // Load cache once for efficiency
        const cache = minerCache.loadCache();

        // Update each client's bestdiff with historical data
        // Worker files are named: address.workername (e.g., bc1xxx.BitAxe3)
        clients.forEach(client => {
            // Build full worker name as stored in ckpool files
            const workerSuffix = client.workername?.split('.').pop() || '';
            const fullWorkerName = workerSuffix ? `${address}.${workerSuffix}` : address;
            client.bestdiff = minerCache.getBestDiffFromAllSources(fullWorkerName, client.bestdiff, cache);
        });
        // Save cache once after the loop (getBestDiffFromAllSources only updates in-memory)
        minerCache.saveCache(cache);

        // Update user's bestDiff - use the highest from all their workers
        let userBestDiff = parsed.bestDiff;
        clients.forEach(client => {
            if (client.bestdiff > userBestDiff) {
                userBestDiff = client.bestdiff;
            }
        });
        parsed.bestDiff = userBestDiff;

        res.render('stats', {
            error: null,
            address,
            user: parsed,
            clients: clients,
            formatHashrate,
            formatDifficulty,
            timeAgo
        });
    } catch (err) {
        console.error(`Error loading stats for ${address}:`, err);
        res.render('stats', {
            error: 'Failed to load statistics',
            address,
            user: null,
            clients: [],
            formatHashrate,
            formatDifficulty,
            timeAgo
        });
    }
});

// Individual Worker stats page
router.get('/stats/:address/:worker', async (req, res) => {
    const { address, worker } = req.params;

    // Basic BTC address validation
    if (!address || !/^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,62}$/.test(address)) {
        return res.render('worker-stats', {
            error: 'Invalid Bitcoin address',
            address,
            worker,
            workerData: null,
            formatHashrate,
            formatDifficulty,
            timeAgo
        });
    }

    try {
        // Get worker stats using the full worker name (address.worker)
        const fullWorkerName = `${address}.${worker}`;
        const [workerStats, clientData] = await Promise.all([
            ckpool.getWorkerStats(address, worker),
            ckpool.getWorkerClients(fullWorkerName)
        ]);

        if (process.env.NODE_ENV !== 'production') {
            console.log(`Worker stats for ${fullWorkerName}:`, JSON.stringify(workerStats));
            console.log(`Worker clients for ${fullWorkerName}:`, JSON.stringify(clientData));
        }

        if (!workerStats || workerStats.error || workerStats === 'unknown') {
            return res.render('worker-stats', {
                error: null,
                address,
                worker,
                workerData: null,
                formatHashrate,
                formatDifficulty,
                timeAgo
            });
        }

        // Parse worker stats
        const NONCES_PER_SHARE = 4294967296;
        const hashrate1m = (workerStats.dsps1 || 0) * NONCES_PER_SHARE;
        const hashrate5m = (workerStats.dsps5 || 0) * NONCES_PER_SHARE;
        const hashrate1h = (workerStats.dsps60 || 0) * NONCES_PER_SHARE;
        const hashrate1d = (workerStats.dsps1440 || 0) * NONCES_PER_SHARE;
        const hashrate7d = (workerStats.dsps10080 || 0) * NONCES_PER_SHARE;

        // Get best diff from all sources
        const cache = minerCache.loadCache();
        const apiBestDiff = Math.max(
            workerStats.bestever || 0,
            workerStats.bestshare || 0,
            workerStats.bestdiff || 0
        );
        const bestDiff = minerCache.getBestDiffFromAllSources(fullWorkerName, apiBestDiff, cache);
        // Save cache once after lookup (getBestDiffFromAllSources only updates in-memory)
        minerCache.saveCache(cache);

        // Parse client info for miner type
        let minerType = 'Unknown';
        let useragent = '';
        let clientInfo = null;
        if (clientData && clientData.clients && clientData.clients.length > 0) {
            const client = clientData.clients[0];
            const parsed = require('../lib/stats-parser').parseMinerType(client.useragent);
            minerType = parsed.name;
            useragent = client.useragent;
            clientInfo = {
                diff: client.diff || 0,
                idle: client.idle || false
            };
        }

        const workerData = {
            name: worker,
            fullName: fullWorkerName,
            hashrate: {
                current: hashrate1m,
                avg5m: hashrate5m,
                avg1h: hashrate1h,
                avg24h: hashrate1d,
                avg7d: hashrate7d
            },
            shares: workerStats.shares || workerStats.accepted || 0,
            bestDiff: bestDiff,
            lastShare: workerStats.lastshare || 0,
            isIdle: clientInfo?.idle || (workerStats.lastshare > 0 && (Date.now() / 1000 - workerStats.lastshare > 300)),
            minerType: minerType,
            useragent: useragent,
            currentDiff: clientInfo?.diff || 0
        };

        res.render('worker-stats', {
            error: null,
            address,
            worker,
            workerData,
            formatHashrate,
            formatDifficulty,
            timeAgo
        });
    } catch (err) {
        console.error(`Error loading worker stats for ${address}.${worker}:`, err);
        res.render('worker-stats', {
            error: 'Failed to load worker statistics',
            address,
            worker,
            workerData: null,
            formatHashrate,
            formatDifficulty,
            timeAgo
        });
    }
});

// Efficiency Dashboard
router.get('/dashboard', async (req, res) => {
    try {
        res.render('dashboard', {
            title: 'Efficiency Dashboard'
        });
    } catch (err) {
        console.error('Error loading dashboard:', err);
        res.render('error', { error: 'Failed to load dashboard' });
    }
});

// Pool overview page
router.get('/pool', async (req, res) => {
    try {
        // Fetch pool stats and all clients in parallel
        const [poolStats, allClients] = await Promise.all([
            ckpool.getPoolStats(),
            ckpool.getAllClients()
        ]);

        const parsed = parsePoolStats(poolStats.poolstats, poolStats.stratifier, poolStats.connector);

        // Calculate additional stats
        const networkHashrate = parsed.networkDiff > 0 ? (parsed.networkDiff * Math.pow(2, 32)) / 600 : 0;
        const networkShare = parsed.hashrate > 0 && networkHashrate > 0 ? (parsed.hashrate / networkHashrate) * 100 : 0;
        const expectedBlockTime = parsed.hashrate > 0 && parsed.networkDiff > 0
            ? (parsed.networkDiff * Math.pow(2, 32)) / parsed.hashrate
            : Infinity;

        // Aggregate miner types
        const minerTypes = aggregateMinerTypes(allClients);

        res.render('pool', {
            pool: parsed,
            raw: poolStats,
            networkHashrate,
            networkShare,
            expectedBlockTime,
            minerTypes,
            formatHashrate,
            formatDifficulty,
            timeAgo
        });
    } catch (err) {
        console.error('Error loading pool stats:', err);
        res.render('pool', {
            pool: null,
            raw: null,
            networkHashrate: 0,
            networkShare: 0,
            expectedBlockTime: Infinity,
            minerTypes: [],
            formatHashrate,
            formatDifficulty,
            timeAgo
        });
    }
});

module.exports = router;
