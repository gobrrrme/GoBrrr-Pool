const express = require('express');
const router = express.Router();
const ckpool = require('../lib/ckpool-client');
const { CKPoolClient } = require('../lib/ckpool-client');
const { parseUserStats, parsePoolStats, aggregateMinerTypes, parseMinerType, formatHashrate, formatDifficulty } = require('../lib/stats-parser');
const db             = require('../lib/db');
const xpLib          = require('../lib/xp');
const warriorTracker = require('../lib/warrior-tracker');
const lnbits         = require('../lib/lnbits');
const cron           = require('node-cron');

// War Room: second ckpool instance for Knots node (only active if env var set)
const knotsSocketDir = process.env.CKPOOL_KNOTS_SOCKET_DIR;
const knotsClient = knotsSocketDir ? new CKPoolClient(knotsSocketDir) : null;
const minerCache = require('../lib/miner-cache');

// Mempool API base URL - can be local (Umbrel) or public
const MEMPOOL_API = process.env.MEMPOOL_API_URL || 'https://mempool.space/api';

// Cache for API responses
let networkCache     = { data: null, timestamp: 0 };
let priceCache       = { data: null, timestamp: 0 };
let blocksCache      = { data: null, timestamp: 0 };
let poolCache        = { data: null, timestamp: 0 };
let leaderboardCache = { data: null, ts: 0 };
let efficiencyCache  = { data: null, ts: 0 };
let minerTypesCache  = { data: null, ts: 0 };
const CACHE_TTL             = 30000;
const PRICE_CACHE_TTL       = 60000;
const POOL_CACHE_TTL        = 10000;
const LEADERBOARD_CACHE_TTL = 30000;
const EFFICIENCY_CACHE_TTL  = 30000;
const MINER_TYPES_CACHE_TTL = 30000;

const RPC_TIMEOUT_MS = 8000;

// Bitcoin network stats (comprehensive)
router.get('/network', async (req, res) => {
    try {
        // Check cache
        if (networkCache.data && Date.now() - networkCache.timestamp < CACHE_TTL) {
            return res.json({ success: true, data: networkCache.data });
        }

        // Fetch data in parallel - use ckpool for what we have, mempool for the rest
        // allSettled ensures a single failing source doesn't bring down the whole endpoint
        const results = await Promise.allSettled([
            ckpool.getPoolStats(),
            fetchJSON(`${MEMPOOL_API}/v1/difficulty-adjustment`),
            fetchJSON(`${MEMPOOL_API}/v1/fees/recommended`),
            fetchJSON(`${MEMPOOL_API}/mempool`),
            fetchJSON(`${MEMPOOL_API}/v1/mining/hashrate/3d`),
            fetchJSON(`${MEMPOOL_API}/v1/blocks`)
        ]);
        const [poolStats, diffData, feeData, mempoolData, hashrateData, recentBlocks]
            = results.map(r => r.status === 'fulfilled' ? r.value : null);

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

        if (process.env.NODE_ENV !== 'production') {
            console.log('Raw stratifierstats:', JSON.stringify(poolStats.stratifier, null, 2));
        }

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
        if (leaderboardCache.data && Date.now() - leaderboardCache.ts < LEADERBOARD_CACHE_TTL) {
            return res.json({ success: true, data: leaderboardCache.data });
        }
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
            .filter(item => {
                // Hide workers inactive for more than 28 days
                const lastSeen = cache.lastSeenAt?.[item.fullName] || 0;
                if (lastSeen === 0) return true; // No timestamp yet → keep (migrated entries)
                return lastSeen > Math.floor(Date.now() / 1000) - (28 * 86400);
            })
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

        // Persist any bestDiff updates accumulated during getBestDiffFromAllSources calls
        minerCache.saveCache(cache);

        leaderboardCache = { data: leaderboard, ts: Date.now() };
        res.json({ success: true, data: leaderboard });
    } catch (err) {
        console.error('Leaderboard error:', err);
        if (leaderboardCache.data) return res.json({ success: true, data: leaderboardCache.data, stale: true });
        res.json({ success: true, data: [] });
    }
});

// Connected miner types
router.get('/miner-types', async (req, res) => {
    try {
        if (minerTypesCache.data && Date.now() - minerTypesCache.ts < MINER_TYPES_CACHE_TTL) {
            return res.json({ success: true, data: minerTypesCache.data, cached: true });
        }
        const clientData = await ckpool.getAllClients();

        if (!clientData || !clientData.clients) {
            return res.json({ success: true, data: [] });
        }

        const minerTypes = aggregateMinerTypes(clientData);
        minerTypesCache = { data: minerTypes, ts: Date.now() };
        res.json({ success: true, data: minerTypes });
    } catch (err) {
        console.error('Miner types error:', err);
        if (minerTypesCache.data) return res.json({ success: true, data: minerTypesCache.data, stale: true });
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
        if (efficiencyCache.data && Date.now() - efficiencyCache.ts < EFFICIENCY_CACHE_TTL) {
            return res.json({ success: true, data: efficiencyCache.data });
        }
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
        // Subsidy halves every 210000 blocks; calculate from current height
        const blockSubsidy = 50 / Math.pow(2, Math.floor((parsed.blockHeight || 0) / 210000));
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

        efficiencyCache = { data: efficiency, ts: Date.now() };
        res.json({ success: true, data: efficiency });
    } catch (err) {
        console.error('Efficiency stats error:', err);
        if (efficiencyCache.data) return res.json({ success: true, data: efficiencyCache.data, stale: true });
        res.status(500).json({ success: false, error: err.message });
    }
});

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

// Bitcoin RPC helpers — env vars take priority, DB config is the fallback
// This allows credentials to be set via the admin panel (stored encrypted in DB)
// without needing them in any env file.

function getKnotsRpcParams() {
    const user = process.env.BITCOIN_RPC_USER || db.getConfig('bitcoin_rpc_user') || '';
    const pass = process.env.BITCOIN_RPC_PASS || db.getConfig('bitcoin_rpc_pass') || '';
    const url  = `http://${process.env.BITCOIN_RPC_HOST || '127.0.0.1'}:${process.env.BITCOIN_RPC_PORT || 8332}`;
    return { url, auth: Buffer.from(`${user}:${pass}`).toString('base64') };
}

function getCoreRpcParams() {
    const host = process.env.CORE_RPC_HOST || db.getConfig('core_rpc_host');
    if (!host) return null;
    const port = process.env.CORE_RPC_PORT || db.getConfig('core_rpc_port') || 8332;
    const user = process.env.CORE_RPC_USER || db.getConfig('core_rpc_user') || '';
    const pass = process.env.CORE_RPC_PASS || db.getConfig('core_rpc_pass') || '';
    return { url: `http://${host}:${port}`, auth: Buffer.from(`${user}:${pass}`).toString('base64') };
}

let nodeinfoCache = { data: null, timestamp: 0 };
const NODEINFO_CACHE_TTL = 60000; // 1 minute

async function rpcCall(method, params = []) {
    const { url, auth } = getKnotsRpcParams();
    const signal = AbortSignal.timeout(RPC_TIMEOUT_MS);
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
        body: JSON.stringify({ method, params, id: 1 }),
        signal
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const json = await response.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
}

async function rpcCallCore(method, params = []) {
    const p = getCoreRpcParams();
    if (!p) throw new Error('Core RPC not configured (set via admin panel or CORE_RPC_HOST env var)');
    const signal = AbortSignal.timeout(RPC_TIMEOUT_MS);
    const response = await fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${p.auth}` },
        body: JSON.stringify({ method, params, id: 1 }),
        signal
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const json = await response.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
}

function parseNodeinfo(netinfo, mininginfo) {
    const v = netinfo.version;
    return {
        version: `${Math.floor(v / 10000)}.${Math.floor((v % 10000) / 100)}.${v % 100}`,
        subversion: netinfo.subversion.replace(/\//g, '').replace('Satoshi:', ''),
        connections: netinfo.connections,
        connections_in: netinfo.connections_in,
        connections_out: netinfo.connections_out,
        relayfee: netinfo.relayfee,
        currentblockweight: mininginfo.currentblockweight,
        currentblocktx: mininginfo.currentblocktx,
        pooledtx: mininginfo.pooledtx
    };
}

router.get('/nodeinfo', async (req, res) => {
    try {
        if (nodeinfoCache.data && Date.now() - nodeinfoCache.timestamp < NODEINFO_CACHE_TTL) {
            return res.json({ success: true, data: nodeinfoCache.data });
        }

        const [netinfo, mininginfo] = await Promise.all([
            rpcCall('getnetworkinfo'),
            rpcCall('getmininginfo')
        ]);

        // Format version: 290200 → "29.2.0"
        const v = netinfo.version;
        const versionStr = `${Math.floor(v / 10000)}.${Math.floor((v % 10000) / 100)}.${v % 100}`;

        const data = {
            version: versionStr,
            subversion: netinfo.subversion.replace(/\//g, '').replace('Satoshi:', ''),
            connections: netinfo.connections,
            connections_in: netinfo.connections_in,
            connections_out: netinfo.connections_out,
            networkactive: netinfo.networkactive,
            relayfee: netinfo.relayfee,
            currentblockweight: mininginfo.currentblockweight,
            currentblocktx: mininginfo.currentblocktx,
            pooledtx: mininginfo.pooledtx
        };

        nodeinfoCache = { data, timestamp: Date.now() };
        res.json({ success: true, data });
    } catch (err) {
        console.error('nodeinfo error:', err.message);
        res.json({ success: false, error: err.message });
    }
});

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

// ── War Room: live hashrate battle Core vs Knots ──────────────────────────────
let warroomCache = { data: null, timestamp: 0 };
const WARROOM_CACHE_TTL = 5000; // 5 seconds

router.get('/warroom', async (req, res) => {
    if (!knotsClient) {
        return res.status(503).json({ success: false, error: 'War Room not configured (CKPOOL_KNOTS_SOCKET_DIR not set)' });
    }

    if (warroomCache.data && Date.now() - warroomCache.timestamp < WARROOM_CACHE_TTL) {
        return res.json({ success: true, data: warroomCache.data, cached: true });
    }

    const [coreResult, knotsResult, coreNodeResult, knotsNodeResult, coreWorkersResult, knotsWorkersResult] = await Promise.allSettled([
        ckpool.getPoolStats(),
        knotsClient.getPoolStats(),
        getCoreRpcParams() ? Promise.all([rpcCallCore('getnetworkinfo'), rpcCallCore('getmininginfo')]) : Promise.reject(new Error('no core rpc')),
        Promise.all([rpcCall('getnetworkinfo'), rpcCall('getmininginfo')]),
        ckpool.getAllWorkers(),
        knotsClient.getAllWorkers()
    ]);

    function parseSide(result, label) {
        if (result.status === 'rejected') return { label, online: false, error: result.reason?.message };
        const raw = result.value;
        const parsed = parsePoolStats(raw.poolstats, raw.stratifier, raw.connector);
        return {
            label,
            online: true,
            hashrate:    parsed.hashrate    || 0,
            hashrate1m:  parsed.hashrate1m  || 0,
            hashrate5m:  parsed.hashrate5m  || 0,
            workers:     parsed.workers     || 0,
            users:       parsed.users       || 0,
            blocksFound: parsed.blocksFound || 0,
            bestDiff:    parsed.bestDiff    || 0,
            sps1:        parsed.sps1        || 0,
        };
    }

    const data = {
        core:  parseSide(coreResult,  'Bitcoin Core'),
        knots: parseSide(knotsResult, 'Bitcoin Knots'),
        timestamp: Date.now()
    };

    // Attach node info if RPC calls succeeded
    if (coreNodeResult.status === 'fulfilled') {
        const [netinfo, mininginfo] = coreNodeResult.value;
        data.core.nodeinfo = parseNodeinfo(netinfo, mininginfo);
    }
    if (knotsNodeResult.status === 'fulfilled') {
        const [netinfo, mininginfo] = knotsNodeResult.value;
        data.knots.nodeinfo = parseNodeinfo(netinfo, mininginfo);
    }

    // Process workers into DB (upsert + LN address extraction) in the background
    if (coreWorkersResult.status === 'fulfilled' && coreWorkersResult.value?.workers) {
        warriorTracker.processWorkers(coreWorkersResult.value.workers, 'core');
    }
    if (knotsWorkersResult.status === 'fulfilled' && knotsWorkersResult.value?.workers) {
        warriorTracker.processWorkers(knotsWorkersResult.value.workers, 'knots');
    }

    // Attach workers for Warriors cards, enriched with XP/level from DB
    function parseWorkers(result) {
        if (result.status === 'rejected' || !result.value?.workers) return [];
        return result.value.workers
            .map(w => {
                const full = w.worker || w.workername || '';
                let name = full.includes('.') ? full.split('.').slice(1).join('.') : full;
                if (!name || name.match(/^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{20,}/)) name = 'anon';
                const bestEver  = Math.max(w.bestever || 0, w.bestshare || 0, w.bestdiff || 0);
                const bestDiff  = w.bestdiff || 0;
                const hashrate  = (w.dsps1 || 0) * 4294967296;
                const lastShare = w.lastshare || 0;

                // Enrich with DB data (XP, level, LN address registered)
                const dbW       = full ? db.getWarrior(full) : null;
                const xpVal     = dbW?.xp || 0;
                const levelData = xpLib.getLevel(xpVal);
                const xpProg    = Math.round(xpLib.getLevelProgress(xpVal) * 100);

                return {
                    name, workerKey: full, hashrate, lastShare, bestDiff, bestEver,
                    xp: xpVal, level: levelData.level, levelTitle: levelData.title,
                    xpProgress: xpProg, hasLnAddress: !!dbW?.ln_address
                };
            })
            .filter(w => w.hashrate > 0 || w.bestEver > 0)
            .sort((a, b) => b.hashrate - a.hashrate);
    }
    data.core.warriors  = parseWorkers(coreWorkersResult);
    data.knots.warriors = parseWorkers(knotsWorkersResult);

    // Compute hashrate split percentage (0-100, Core share)
    const total = data.core.hashrate + data.knots.hashrate;
    data.corePct  = total > 0 ? (data.core.hashrate  / total) * 100 : 50;
    data.knotsPct = total > 0 ? (data.knots.hashrate / total) * 100 : 50;

    warroomCache = { data, timestamp: Date.now() };
    res.json({ success: true, data });
});

// ── War Room gamification endpoints ───────────────────────────────────────────

// Warriors with XP/level for a side
router.get('/warroom/warriors/:side', (req, res) => {
    const { side } = req.params;
    if (side !== 'core' && side !== 'knots') {
        return res.status(400).json({ success: false, error: 'Invalid side' });
    }
    const warriors = db.getWarriorsBySide(side).map(w => {
        const levelData = xpLib.getLevel(w.xp);
        const next      = xpLib.getNextLevel(w.xp);
        return {
            workerName:   w.worker_name,
            side:         w.side,
            xp:           w.xp,
            level:        levelData.level,
            levelTitle:   levelData.title,
            nextLevel:    next ? next.level : null,
            xpToNext:     next ? next.threshold - w.xp : 0,
            xpProgress:   Math.round(xpLib.getLevelProgress(w.xp) * 100),
            hasLnAddress: !!w.ln_address,
            weeklyShares: w.weekly_shares,
            totalShares:  w.total_shares,
            lastActive:   w.last_active,
        };
    });
    res.json({ success: true, data: warriors });
});

// Register (or update) a LN address for a worker via POST
router.post('/warroom/register', express.json(), (req, res) => {
    const { workerName, lnAddress } = req.body || {};
    if (!workerName) return res.status(400).json({ success: false, error: 'workerName required' });
    if (lnAddress && !warriorTracker.isValidLnAddress(lnAddress)) {
        return res.status(400).json({ success: false, error: 'Invalid Lightning Address format' });
    }
    db.upsertWarrior({ workerName, lnAddress: lnAddress || null });
    res.json({ success: true });
});

// Recent pool activity feed
router.get('/warroom/activity', (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit) || 20, 50);
    const events = db.getRecentEvents(limit);
    res.json({ success: true, data: events });
});

// ── Pool stats (LNBits balance + donate link) ─────────────────────────────────

let lnPoolCache = { data: null, ts: 0 };

router.get('/warroom/pool', async (req, res) => {
    // Cache for 30s to avoid hammering LNBits
    if (lnPoolCache.data && Date.now() - lnPoolCache.ts < 30000) {
        return res.json({ success: true, data: lnPoolCache.data });
    }
    if (!lnbits.isConfigured()) {
        return res.json({ success: true, data: { configured: false, balanceSats: 0, donateLink: null } });
    }
    try {
        const [balanceSats, donateInfo] = await Promise.all([
            lnbits.getBalance(),
            lnbits.getOrCreatePoolDonateLink().catch(() => null),
        ]);
        const data = { configured: true, balanceSats, donateLink: donateInfo?.lnurl || null };
        lnPoolCache = { data, ts: Date.now() };
        res.json({ success: true, data });
    } catch (err) {
        console.error('[pool]', err.message);
        res.json({ success: true, data: { configured: true, balanceSats: 0, donateLink: null, error: err.message } });
    }
});

// ── Zap flow: user pays LNBits invoice → pool takes 2% → forwards to warrior ──
//
// Step 1: GET /api/warroom/zap-invoice?to=<worker>&amount=<sats>
//         Creates a LNBits invoice for `amount` sats. User pays it.
//         Returns { bolt11, payment_hash }.
//
// Step 2: GET /api/warroom/zap-invoice/status?hash=<payment_hash>
//         Polls until paid. On first detection: deduct 2%, pay warrior, record.
//         Returns { paid: true, payout, fee } or { paid: false }.

const ZAP_AMOUNTS = [21, 100, 500, 1000];

// In-memory store for pending zaps (short-lived, 10 min expiry)
const pendingZaps = new Map(); // payment_hash → { to, lnAddress, amount, status, expiresAt }
setInterval(() => {
    const now = Date.now();
    for (const [hash, z] of pendingZaps) {
        if (z.expiresAt < now) pendingZaps.delete(hash);
    }
}, 5 * 60 * 1000);

router.get('/warroom/zap-invoice', async (req, res) => {
    if (!lnbits.isConfigured()) {
        return res.status(503).json({ success: false, error: 'LNBits not configured' });
    }
    const { to, amount } = req.query;
    if (!to || !ZAP_AMOUNTS.includes(Number(amount))) {
        return res.status(400).json({ success: false, error: 'Invalid params' });
    }
    const warrior = db.getWarrior(to);
    if (!warrior?.ln_address) {
        return res.status(400).json({ success: false, error: 'Warrior has no Lightning Address' });
    }
    try {
        const sats = Number(amount);
        const invoice = await lnbits.createInvoice(sats, `War Room zap → ${to}`);
        pendingZaps.set(invoice.payment_hash, {
            to,
            lnAddress: warrior.ln_address,
            amount:    sats,
            status:    'pending',
            expiresAt: Date.now() + 10 * 60 * 1000,
        });
        res.json({ success: true, bolt11: invoice.bolt11, payment_hash: invoice.payment_hash, amount: sats });
    } catch (err) {
        console.error('[zap-invoice]', err.message);
        res.status(502).json({ success: false, error: err.message });
    }
});

router.get('/warroom/zap-invoice/status', async (req, res) => {
    const { hash } = req.query;
    if (!hash) return res.status(400).json({ success: false, error: 'Missing hash' });

    const zap = pendingZaps.get(hash);
    if (!zap) return res.json({ success: true, paid: false, expired: true });

    if (zap.status === 'paid') {
        return res.json({ success: true, paid: true, payout: zap.payout, fee: zap.fee });
    }
    if (zap.status === 'processing') {
        return res.json({ success: true, paid: false });
    }

    try {
        const paid = await lnbits.checkInvoice(hash);
        if (!paid) return res.json({ success: true, paid: false });

        // Invoice paid — record in DB immediately so cron can retry if payout fails
        zap.status = 'processing';
        const fee    = Math.floor(zap.amount * 0.02);
        const payout = zap.amount - fee;
        db.insertZapPayout({ invoiceHash: hash, toWorker: zap.to, amountSats: zap.amount, payoutSats: payout, feeSats: fee });

        try {
            await executeZapPayout(hash, zap.to, zap.lnAddress, payout, fee);
            zap.status = 'paid';
            zap.payout = payout;
            zap.fee    = fee;
            res.json({ success: true, paid: true, payout, fee });
        } catch (payErr) {
            // Payout failed — DB record stays 'pending', cron will retry
            db.markZapPayoutAttempted(hash, payErr.message);
            zap.status = 'paid'; // invoice WAS paid, just payout pending
            zap.payout = payout;
            zap.fee    = fee;
            console.warn('[zap-status] Payout failed, queued for retry:', payErr.message);
            res.json({ success: true, paid: true, payout, fee, queued: true });
        }
    } catch (err) {
        zap.status = 'pending';
        console.error('[zap-status]', err.message);
        res.json({ success: true, paid: false });
    }
});

// Shared payout executor used by status endpoint and retry cron
async function executeZapPayout(invoiceHash, toWorker, lnAddress, payoutSats, feeSats) {
    const paymentHash = await lnbits.payLnAddress(lnAddress, payoutSats);
    db.markZapPayoutPaid(invoiceHash);
    db.recordZap({ toWorker, amountSats: payoutSats, paymentHash });
    db.addXP(toWorker, xpLib.XP_ZAP_RECEIVED);
    db.addEvent({ type: 'zap', worker: toWorker, amountSats: payoutSats,
        description: `⚡ ${payoutSats} sats zapped to ${toWorker} (${feeSats} sat fee kept in pool)` });
    lnPoolCache.ts = 0;
}

// ── Retry cron: every 21 minutes, retry all pending zap payouts ───────────────

cron.schedule('*/21 * * * *', async () => {
    const pending = db.getPendingZapPayouts();
    if (pending.length === 0) return;
    console.log(`[zap-retry] Retrying ${pending.length} pending zap payout(s)…`);
    for (const row of pending) {
        const warrior = db.getWarrior(row.to_worker);
        if (!warrior?.ln_address) {
            db.markZapPayoutAttempted(row.invoice_hash, 'Warrior has no LN address');
            continue;
        }
        try {
            await executeZapPayout(row.invoice_hash, row.to_worker, warrior.ln_address, row.payout_sats, row.fee_sats);
            console.log(`[zap-retry] ✓ Paid ${row.payout_sats} sats to ${row.to_worker}`);
        } catch (err) {
            db.markZapPayoutAttempted(row.invoice_hash, err.message);
            console.warn(`[zap-retry] ✗ ${row.to_worker}: ${err.message}`);
        }
    }
});

// ── Spawn campaigns ───────────────────────────────────────────────────────────

router.get('/warroom/campaigns', (req, res) => {
    res.json({ success: true, data: db.getCampaigns() });
});

// Create funding invoice for a campaign (anyone can fund)
router.post('/warroom/campaigns/:id/invoice', express.json(), async (req, res) => {
    if (!lnbits.isConfigured()) {
        return res.status(503).json({ success: false, error: 'LNBits not configured' });
    }
    const campaign = db.getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (campaign.status !== 'active') {
        return res.status(400).json({ success: false, error: 'Campaign already ' + campaign.status });
    }

    // Campaigns use the pool donate link for now (no sub-wallet needed)
    try {
        const donateInfo = await lnbits.getOrCreatePoolDonateLink();
        res.json({ success: true, lnurl: donateInfo.lnurl, campaignName: campaign.name });
    } catch (err) {
        res.status(502).json({ success: false, error: err.message });
    }
});

// ── Background uptime XP timer ────────────────────────────────────────────────
// Every 60 seconds: award 1 XP to each worker active in the last 2 minutes

async function awardUptimeXP() {
    if (!knotsClient) return;
    try {
        const [coreW, knotsW] = await Promise.allSettled([
            ckpool.getAllWorkers(),
            knotsClient.getAllWorkers(),
        ]);
        if (coreW.value?.workers)  warriorTracker.awardUptimeXP(coreW.value.workers, 1, 120);
        if (knotsW.value?.workers) warriorTracker.awardUptimeXP(knotsW.value.workers, 1, 120);
    } catch (err) {
        // Non-fatal, just log
        console.error('[XP] Uptime award error:', err.message);
    }
}

// Start after 30s to give ckpool sockets time to connect
setTimeout(() => {
    awardUptimeXP();
    setInterval(awardUptimeXP, 60000);
}, 30000);

// ── Weekly reward cron (every Monday 00:00 UTC) ───────────────────────────────

async function runWeeklyRewards() {
    if (!knotsClient) return;
    if (!lnbits.isConfigured()) {
        console.log('[WEEKLY] LNBits not configured — skipping reward payout');
        return;
    }
    console.log('[WEEKLY] Running weekly reward payout...');

    let balance;
    try { balance = await lnbits.getBalance(); }
    catch (err) { console.error('[WEEKLY] Cannot get balance:', err.message); return; }

    const weekStart = Math.floor(Date.now() / 1000);
    const perSide   = Math.floor(balance * 0.05); // 5% of pool per winning side

    if (perSide < 1) {
        console.log(`[WEEKLY] Pool balance too low (${balance} sats) — skipping`);
        return;
    }

    for (const side of ['core', 'knots']) {
        const winner = db.getTopWarriorByWeeklyShares(side);
        if (!winner || winner.weekly_shares <= 0) {
            console.log(`[WEEKLY] No active warriors on ${side} — skipping`);
            continue;
        }
        console.log(`[WEEKLY] Winner ${side}: ${winner.worker_name} (${winner.weekly_shares} shares) → ${perSide} sats`);

        if (winner.ln_address) {
            try {
                // Apply 2% pool fee to weekly reward payout as well
                const fee    = Math.floor(perSide * 0.02);
                const payout = perSide - fee;
                const hash   = await lnbits.payLnAddress(winner.ln_address, payout);
                db.recordReward({ weekStart, side, winnerWorker: winner.worker_name, amountSats: payout, paymentHash: hash, status: 'paid' });
                db.addXP(winner.worker_name, xpLib.XP_WEEKLY_WIN);
                db.addEvent({ type: 'reward', worker: winner.worker_name, amountSats: payout,
                    description: `🏆 Weekly ${side} winner: ${payout} sats (${fee} sat fee kept in pool)` });
                console.log(`[WEEKLY] Paid ${payout} sats to ${winner.worker_name} (fee: ${fee} sats, hash: ${hash})`);
            } catch (err) {
                db.recordReward({ weekStart, side, winnerWorker: winner.worker_name, amountSats: perSide, paymentHash: null, status: 'failed' });
                console.error(`[WEEKLY] Payment failed for ${winner.worker_name}:`, err.message);
            }
        } else {
            // No LN address — reward stays in pool wallet, logged for transparency
            db.recordReward({ weekStart, side, winnerWorker: winner.worker_name, amountSats: perSide, paymentHash: null, status: 'no_address' });
            db.addEvent({ type: 'reward', worker: winner.worker_name, amountSats: perSide,
                description: `🏆 Weekly ${side} winner ${winner.worker_name} has no LN address — ${perSide} sats remain in pool` });
            console.log(`[WEEKLY] ${winner.worker_name} has no LN address — ${perSide} sats stay in pool wallet`);
        }

        db.resetWeeklyShares(side);
    }

    lnPoolCache.ts = 0; // force pool balance refresh
    console.log('[WEEKLY] Done.');
}

// Every Monday 00:00 UTC
cron.schedule('0 0 * * MON', runWeeklyRewards, { timezone: 'UTC' });

module.exports = router;
