const express = require('express');
const router = express.Router();
const ckpool = require('../lib/ckpool-client');
const { parseUserStats, parsePoolStats, aggregateMinerTypes, parseMinerType } = require('../lib/stats-parser');
const minerCache = require('../lib/miner-cache');

// Mempool API base URL - can be local (Umbrel) or public
const MEMPOOL_API = process.env.MEMPOOL_API_URL || 'https://mempool.space/api';

// Cache for API responses
let networkCache = { data: null, timestamp: 0 };
let priceCache = { data: null, timestamp: 0 };
let blocksCache = { data: null, timestamp: 0 };
let poolCache = { data: null, timestamp: 0 };
const CACHE_TTL = 30000; // 30 seconds
const PRICE_CACHE_TTL = 60000; // 1 minute
const POOL_CACHE_TTL = 10000; // 10 seconds for pool stats

// Bitcoin network stats (comprehensive)
router.get('/network', async (req, res) => {
    try {
        // Check cache
        if (networkCache.data && Date.now() - networkCache.timestamp < CACHE_TTL) {
            return res.json({ success: true, data: networkCache.data });
        }

        // Fetch data in parallel - use ckpool for what we have, mempool for the rest
        const [
            poolStats,
            diffData,
            feeData,
            mempoolData,
            hashrateData,
            recentBlocks
        ] = await Promise.all([
            ckpool.getPoolStats(),
            fetchJSON(`${MEMPOOL_API}/v1/difficulty-adjustment`),
            fetchJSON(`${MEMPOOL_API}/v1/fees/recommended`),
            fetchJSON(`${MEMPOOL_API}/mempool`),
            fetchJSON(`${MEMPOOL_API}/v1/mining/hashrate/3d`),
            fetchJSON(`${MEMPOOL_API}/v1/blocks`)
        ]);

        // Get block height and network diff from ckpool (local source)
        const ckpoolParsed = parsePoolStats(poolStats.poolstats, poolStats.stratifier, poolStats.connector);
        const blockHeight = ckpoolParsed.blockHeight || hashrateData?.currentHeight || 0;
        const currentDifficulty = ckpoolParsed.networkDiff || hashrateData?.currentDifficulty || 0;

        // Parse recent blocks for miner info
        const parsedBlocks = (recentBlocks || []).slice(0, 6).map(block => ({
            height: block.height,
            hash: block.id,
            time: block.timestamp,
            miner: block.extras?.pool?.name || 'Unknown',
            txCount: block.tx_count,
            size: block.size,
            weight: block.weight
        }));

        const data = {
            blockHeight: blockHeight,
            networkHashrate: hashrateData?.currentHashrate || 0,
            difficulty: currentDifficulty,
            difficultyAdjustment: diffData ? {
                estimatedRetargetDate: diffData.estimatedRetargetDate,
                remainingBlocks: diffData.remainingBlocks,
                remainingTime: diffData.remainingTime,
                progressPercent: diffData.progressPercent,
                difficultyChange: diffData.difficultyChange,
                previousRetarget: diffData.previousRetarget
            } : null,
            mempool: {
                size: mempoolData?.vsize || 0,
                count: mempoolData?.count || 0,
                totalFee: mempoolData?.total_fee || 0
            },
            fees: {
                fastest: feeData?.fastestFee || 0,
                halfHour: feeData?.halfHourFee || 0,
                hour: feeData?.hourFee || 0,
                economy: feeData?.economyFee || 0,
                minimum: feeData?.minimumFee || 0
            },
            recentBlocks: parsedBlocks,
            lastBlockMiner: parsedBlocks[0]?.miner || 'Unknown',
            lastBlockTime: parsedBlocks[0]?.time || 0,
            timestamp: Date.now()
        };

        // Update cache
        networkCache = { data, timestamp: Date.now() };

        res.json({ success: true, data });
    } catch (err) {
        console.error('Network stats error:', err);
        // Return cached data if available, even if stale
        if (networkCache.data) {
            return res.json({ success: true, data: networkCache.data, stale: true });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// BTC price
router.get('/price', async (req, res) => {
    try {
        if (priceCache.data && Date.now() - priceCache.timestamp < PRICE_CACHE_TTL) {
            return res.json({ success: true, data: priceCache.data });
        }

        const data = await fetchJSON(`${MEMPOOL_API}/v1/prices`);

        priceCache = {
            data: {
                USD: data?.USD || 0,
                EUR: data?.EUR || 0,
                GBP: data?.GBP || 0,
                timestamp: Date.now()
            },
            timestamp: Date.now()
        };

        res.json({ success: true, data: priceCache.data });
    } catch (err) {
        console.error('Price fetch error:', err);
        if (priceCache.data) {
            return res.json({ success: true, data: priceCache.data, stale: true });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// Recent blocks with miner info
router.get('/blocks/recent', async (req, res) => {
    try {
        if (blocksCache.data && Date.now() - blocksCache.timestamp < CACHE_TTL) {
            return res.json({ success: true, data: blocksCache.data });
        }

        const blocks = await fetchJSON(`${MEMPOOL_API}/v1/blocks`);

        const data = (blocks || []).slice(0, 10).map(block => ({
            height: block.height,
            hash: block.id,
            time: block.timestamp,
            timeAgo: timeAgo(block.timestamp),
            miner: block.extras?.pool?.name || 'Unknown',
            minerSlug: block.extras?.pool?.slug || '',
            txCount: block.tx_count,
            size: block.size,
            weight: block.weight,
            reward: block.extras?.reward || 0
        }));

        blocksCache = { data, timestamp: Date.now() };

        res.json({ success: true, data });
    } catch (err) {
        console.error('Recent blocks error:', err);
        if (blocksCache.data) {
            return res.json({ success: true, data: blocksCache.data, stale: true });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// Pool statistics (with caching)
router.get('/pool', async (req, res) => {
    try {
        // Check cache first
        if (poolCache.data && Date.now() - poolCache.timestamp < POOL_CACHE_TTL) {
            return res.json({ success: true, data: poolCache.data, cached: true });
        }

        const poolStats = await ckpool.getPoolStats();

        // Debug: log raw stratifierstats
        console.log('Raw stratifierstats:', JSON.stringify(poolStats.stratifier, null, 2));

        const parsed = parsePoolStats(poolStats.poolstats, poolStats.stratifier, poolStats.connector);

        const data = {
            ...parsed,
            raw: poolStats,
            timestamp: Date.now()
        };

        // Update cache
        poolCache = { data, timestamp: Date.now() };

        res.json({ success: true, data });
    } catch (err) {
        console.error('Pool stats error:', err);
        // Return cached data if available
        if (poolCache.data) {
            return res.json({ success: true, data: poolCache.data, stale: true });
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// User/Worker statistics by BTC address
router.get('/stats/:address', async (req, res) => {
    const { address } = req.params;

    // Basic BTC address validation
    if (!address || !/^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,62}$/.test(address)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid Bitcoin address'
        });
    }

    try {
        const userStats = await ckpool.getUserStats(address);
        const parsed = parseUserStats(userStats);

        res.json({
            success: true,
            data: {
                ...parsed,
                raw: userStats,
                timestamp: Date.now()
            }
        });
    } catch (err) {
        console.error(`Stats error for ${address}:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Leaderboard - top miners by best difficulty
router.get('/leaderboard', async (req, res) => {
    try {
        // Get all workers and clients from ckpool
        const [workersData, clientsData] = await Promise.all([
            ckpool.getAllWorkers(),
            ckpool.getAllClients()
        ]);

        if (!workersData || !workersData.workers || !Array.isArray(workersData.workers)) {
            return res.json({ success: true, data: [] });
        }

        // Update persistent cache with current client data (stores miner types for later)
        let cache = minerCache.updateFromClients(
            clientsData?.clients || [],
            parseMinerType
        );

        // Update best difficulties cache (stores highest value ever seen)
        cache = minerCache.updateBestDiffs(workersData.workers, cache);

        // Build set of currently connected workers
        const connectedWorkers = new Set();
        if (clientsData && clientsData.clients) {
            clientsData.clients.forEach(client => {
                if (client.workername) {
                    connectedWorkers.add(client.workername);
                }
            });
        }

        // Get stats for each worker and sort by best difficulty
        const leaderboard = workersData.workers
            .map(worker => {
                const fullName = worker.worker || worker.workername || '';
                // Get the highest best diff from API
                const ckpoolBest = Math.max(
                    worker.bestever || 0,
                    worker.bestshare || 0,
                    worker.bestdiff || 0
                );
                // Use all sources: our cache, API values, AND ckpool worker files
                const bestDiff = minerCache.getBestDiffFromAllSources(fullName, ckpoolBest, cache);
                return { fullName, bestDiff, worker };
            })
            .filter(item => item.bestDiff > 0)
            .map(item => {
                const { fullName, bestDiff, worker } = item;
                // Extract worker name (part after the dot), show "anon" if no worker name
                let workerName = null;
                if (fullName.includes('.')) {
                    workerName = fullName.split('.').slice(1).join('.');
                }
                // If workerName is empty, null, or looks like a BTC address, show "anon"
                if (!workerName || workerName.match(/^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{20,}/)) {
                    workerName = 'anon';
                }
                // Get miner type from persistent cache (handles historical data)
                const minerType = minerCache.getMinerType(fullName, cache);
                // Check if worker is currently connected
                const isOnline = connectedWorkers.has(fullName);
                return {
                    workerName: workerName || 'anon',
                    minerType: minerType,
                    isOnline: isOnline,
                    bestDiff: bestDiff,
                    bestDiffFormatted: formatDifficulty(bestDiff),
                    hashrate: (worker.dsps1 || 0) * 4294967296,
                    hashrateFormatted: formatHashrate((worker.dsps1 || 0) * 4294967296)
                };
            })
            .sort((a, b) => b.bestDiff - a.bestDiff)
            .slice(0, 99); // Top 99

        res.json({ success: true, data: leaderboard });
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.json({ success: true, data: [] });
    }
});

// Connected miner types
router.get('/miner-types', async (req, res) => {
    try {
        // Get all connected clients
        const clientData = await ckpool.getAllClients();

        if (!clientData || !clientData.clients) {
            return res.json({ success: true, data: [] });
        }

        // Aggregate by miner type
        const minerTypes = aggregateMinerTypes(clientData);

        res.json({ success: true, data: minerTypes });
    } catch (err) {
        console.error('Miner types error:', err);
        res.json({ success: true, data: [] });
    }
});

// Found blocks by pool
router.get('/blocks', async (req, res) => {
    try {
        // This would need to be implemented based on ckpool's block tracking
        res.json({
            success: true,
            data: {
                blocks: [],
                timestamp: Date.now()
            }
        });
    } catch (err) {
        console.error('Blocks fetch error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Efficiency Dashboard - Real-time mining efficiency metrics
router.get('/efficiency', async (req, res) => {
    try {
        // Fetch pool stats and network data in parallel
        const [poolStats, networkData, feeData] = await Promise.all([
            ckpool.getPoolStats(),
            fetchJSON(`${MEMPOOL_API}/v1/mining/hashrate/3d`),
            fetchJSON(`${MEMPOOL_API}/v1/fees/recommended`)
        ]);

        const parsed = parsePoolStats(poolStats.poolstats, poolStats.stratifier, poolStats.connector);

        // Network stats - prefer ckpool data (local), fallback to mempool API
        const networkHashrate = networkData?.currentHashrate || 700e18; // ~700 EH/s fallback
        const networkDifficulty = parsed.networkDiff || networkData?.currentDifficulty || 100e12;

        // Pool's share of network
        const poolHashrate = parsed.hashrate || 0;
        const networkShare = poolHashrate > 0 ? (poolHashrate / networkHashrate) * 100 : 0;

        // Expected time to find a block (in seconds)
        // Time = Difficulty * 2^32 / Hashrate
        const expectedBlockTime = poolHashrate > 0
            ? (networkDifficulty * Math.pow(2, 32)) / poolHashrate
            : Infinity;

        // Daily expected blocks
        const dailyExpectedBlocks = poolHashrate > 0
            ? (86400 / expectedBlockTime)
            : 0;

        // Probability of finding at least one block in 24h
        // P = 1 - e^(-λ) where λ = expected blocks per day
        const dailyBlockProbability = 1 - Math.exp(-dailyExpectedBlocks);

        // Transaction fee potential from mempool
        const currentFees = {
            fastest: feeData?.fastestFee || 0,
            halfHour: feeData?.halfHourFee || 0,
            hour: feeData?.hourFee || 0,
            economy: feeData?.economyFee || 0
        };

        // Estimated fees in next block (avg tx size 250 vB, ~3000 txs per block)
        const estimatedBlockFees = (currentFees.hour * 250 * 3000) / 100000000; // in BTC

        // Block reward estimation (subsidy + estimated fees)
        const blockSubsidy = 3.125; // BTC
        const blockReward = blockSubsidy + estimatedBlockFees;

        // Expected daily revenue (purely statistical)
        const expectedDailyRevenue = dailyExpectedBlocks * blockReward;

        // Efficiency metrics
        const efficiency = {
            // Pool stats
            poolHashrate: poolHashrate,
            poolHashrateFormatted: formatHashrate(poolHashrate),
            activeWorkers: parsed.workers,
            activeUsers: parsed.users,

            // Network comparison
            networkHashrate: networkHashrate,
            networkHashrateFormatted: formatHashrate(networkHashrate),
            networkShare: networkShare,
            networkShareFormatted: formatSmallPercent(networkShare),

            // Block finding estimates
            expectedBlockTime: expectedBlockTime,
            expectedBlockTimeFormatted: formatTime(expectedBlockTime),
            dailyExpectedBlocks: dailyExpectedBlocks,
            dailyBlockProbability: dailyBlockProbability,
            dailyBlockProbabilityFormatted: formatSmallPercent(dailyBlockProbability * 100),

            // Revenue estimates (statistical expectation)
            blockReward: blockReward,
            expectedDailyRevenue: expectedDailyRevenue,
            expectedDailyRevenueFormatted: formatSmallBTC(expectedDailyRevenue),

            // Fee market
            currentFees: currentFees,
            estimatedBlockFees: estimatedBlockFees,
            estimatedBlockFeesFormatted: estimatedBlockFees.toFixed(4) + ' BTC',

            // Share efficiency
            sharesPerSecond: parsed.sps1,
            diffSharesAccepted: parsed.accepted,
            diffSharesRejected: parsed.rejected,
            rejectRate: parsed.accepted > 0
                ? ((parsed.rejected / (parsed.accepted + parsed.rejected)) * 100).toFixed(2) + '%'
                : '0%',

            // Best performance
            bestDifficulty: parsed.bestDiff,
            bestDifficultyFormatted: formatDifficulty(parsed.bestDiff),

            timestamp: Date.now()
        };

        res.json({ success: true, data: efficiency });
    } catch (err) {
        console.error('Efficiency stats error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Helper: Format hashrate
function formatHashrate(h) {
    if (!h || h === 0) return '0 H/s';
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s', 'ZH/s'];
    let i = 0;
    while (h >= 1000 && i < units.length - 1) { h /= 1000; i++; }
    return h.toFixed(2) + ' ' + units[i];
}

// Helper: Format time duration
function formatTime(seconds) {
    if (!isFinite(seconds)) return 'Never (need more hashrate)';
    if (seconds < 60) return Math.round(seconds) + ' seconds';
    if (seconds < 3600) return Math.round(seconds / 60) + ' minutes';
    if (seconds < 86400) return Math.round(seconds / 3600) + ' hours';
    if (seconds < 2592000) return Math.round(seconds / 86400) + ' days';
    if (seconds < 31536000) return Math.round(seconds / 2592000) + ' months';
    const years = seconds / 31536000;
    if (years >= 1000000) return Math.round(years / 1000000).toLocaleString() + ' million years';
    if (years >= 1000) return Math.round(years / 1000).toLocaleString() + 'k years';
    return Math.round(years).toLocaleString() + ' years';
}

// Helper: Format difficulty
function formatDifficulty(diff) {
    if (!diff) return '0';
    if (diff >= 1e15) return (diff / 1e15).toFixed(2) + ' P';
    if (diff >= 1e12) return (diff / 1e12).toFixed(2) + ' T';
    if (diff >= 1e9) return (diff / 1e9).toFixed(2) + ' G';
    if (diff >= 1e6) return (diff / 1e6).toFixed(2) + ' M';
    if (diff >= 1e3) return (diff / 1e3).toFixed(2) + ' K';
    return diff.toFixed(2);
}

// Helper: Format very small percentages with 2 significant digits
function formatSmallPercent(percent) {
    if (!percent || percent === 0) return '0%';
    if (percent >= 1) return percent.toFixed(2) + '%';
    // For small values, show 2 significant digits
    const str = percent.toString();
    if (str.includes('e')) {
        // Handle scientific notation
        return percent.toPrecision(2) + '%';
    }
    // Find position of first non-zero digit after decimal
    const match = str.match(/^0\.(0*)[1-9]/);
    if (match) {
        const leadingZeros = match[1].length;
        return percent.toFixed(leadingZeros + 2) + '%';
    }
    return percent.toFixed(2) + '%';
}

// Helper: Format very small BTC amounts in readable form
function formatSmallBTC(btc) {
    if (!btc || btc === 0) return '0 BTC';
    if (btc >= 1) return btc.toFixed(4) + ' BTC';
    if (btc >= 0.001) return (btc * 1000).toFixed(4) + ' mBTC';
    if (btc >= 0.000001) return Math.round(btc * 100000000) + ' sats';
    // For extremely small values (statistical expected values)
    const sats = btc * 100000000;
    if (sats >= 0.01) return sats.toFixed(4) + ' sats';
    if (sats >= 0.000001) return sats.toFixed(8) + ' sats';
    // Sub-satoshi values - show as fraction
    return '< 0.00000001 sats';
}

// Helper function to fetch JSON
async function fetchJSON(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (err) {
        console.error(`Fetch error for ${url}:`, err.message);
        return null;
    }
}

// Helper function for time ago
function timeAgo(timestamp) {
    const seconds = Math.floor(Date.now() / 1000 - timestamp);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

module.exports = router;
