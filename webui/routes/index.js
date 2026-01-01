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
            formatDifficulty
        });
    } catch (err) {
        console.error('Error loading home page:', err);
        res.render('index', {
            pool: null,
            formatHashrate,
            formatDifficulty
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

        // Debug log
        console.log(`User stats for ${address}:`, JSON.stringify(userStats));
        console.log(`Client info for ${address}:`, JSON.stringify(clientData));

        // parseUserStats returns null for invalid/unknown users
        const parsed = parseUserStats(userStats);
        const clients = parseClientInfo(clientData);

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
