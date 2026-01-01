// Utility functions for parsing and formatting mining stats

function formatHashrate(hashesPerSecond) {
    if (!hashesPerSecond || hashesPerSecond === 0) return '0 H/s';

    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
    let unitIndex = 0;
    let value = hashesPerSecond;

    while (value >= 1000 && unitIndex < units.length - 1) {
        value /= 1000;
        unitIndex++;
    }

    return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function formatDifficulty(diff) {
    if (!diff) return '0';

    if (diff >= 1e15) return (diff / 1e15).toFixed(2) + ' P';
    if (diff >= 1e12) return (diff / 1e12).toFixed(2) + ' T';
    if (diff >= 1e9) return (diff / 1e9).toFixed(2) + ' G';
    if (diff >= 1e6) return (diff / 1e6).toFixed(2) + ' M';
    if (diff >= 1e3) return (diff / 1e3).toFixed(2) + ' K';

    return diff.toFixed(2);
}

function formatTimestamp(timestamp) {
    if (!timestamp) return 'Never';

    const date = new Date(timestamp * 1000);
    return date.toLocaleString();
}

function timeAgo(timestamp) {
    if (!timestamp) return 'Never';

    const seconds = Math.floor(Date.now() / 1000 - timestamp);

    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

// Helper to safely get nested value
function getNestedValue(obj, path, defaultValue = 0) {
    if (!obj) return defaultValue;
    const keys = path.split('.');
    let value = obj;
    for (const key of keys) {
        if (value && typeof value === 'object' && key in value) {
            value = value[key];
        } else {
            return defaultValue;
        }
    }
    // If value is an object, return default (prevents [object Object])
    if (typeof value === 'object') return defaultValue;
    return value;
}

// Hashrate calculation: dsps (diff shares per second) * 2^32
const NONCES_PER_SHARE = 4294967296; // 2^32

function parsePoolStats(poolstats, stratifier, connector) {
    const pool = {
        // Hashrate values
        hashrate: 0,
        hashrate1m: 0,
        hashrate5m: 0,
        hashrate15m: 0,
        hashrate1h: 0,
        hashrate6h: 0,
        hashrate1d: 0,
        hashrate7d: 0,
        // Pool stats
        users: 0,
        workers: 0,
        shares: 0,
        accepted: 0,
        rejected: 0,
        // Shares per second
        sps1: 0,
        sps5: 0,
        // Best difficulty (pool-wide)
        bestDiff: 0,
        // Network
        networkDiff: 0,
        blocksFound: 0,
        // Timing
        uptime: 0,
        startTime: 0,
        lastUpdate: 0,
        connections: 0
    };

    // Parse poolstats (real mining statistics from stratifier API)
    if (poolstats && !poolstats.error) {
        pool.users = poolstats.users || 0;
        pool.workers = poolstats.workers || 0;
        pool.shares = poolstats.shares || 0;
        pool.accepted = poolstats.accepted || 0;
        pool.rejected = poolstats.rejected || 0;
        pool.sps1 = poolstats.sps1 || 0;
        pool.sps5 = poolstats.sps5 || 0;
        pool.startTime = poolstats.start || 0;
        pool.lastUpdate = poolstats.update || 0;

        // Calculate uptime
        if (pool.startTime > 0) {
            pool.uptime = Math.floor(Date.now() / 1000) - pool.startTime;
        }

        // Calculate hashrates from dsps values
        pool.hashrate1m = (poolstats.dsps1 || 0) * NONCES_PER_SHARE;
        pool.hashrate5m = (poolstats.dsps5 || 0) * NONCES_PER_SHARE;
        pool.hashrate15m = (poolstats.dsps15 || 0) * NONCES_PER_SHARE;
        pool.hashrate1h = (poolstats.dsps60 || 0) * NONCES_PER_SHARE;
        pool.hashrate6h = (poolstats.dsps360 || 0) * NONCES_PER_SHARE;
        pool.hashrate1d = (poolstats.dsps1440 || 0) * NONCES_PER_SHARE;
        pool.hashrate7d = (poolstats.dsps10080 || 0) * NONCES_PER_SHARE;

        // Use 1 minute hashrate as main display value
        pool.hashrate = pool.hashrate1m;

        // Best difficulty for the pool
        pool.bestDiff = poolstats.bestdiff || 0;

        // Network info from ckpool (from current workbase)
        pool.blockHeight = poolstats.height || 0;
        pool.networkDiff = poolstats.diff || 0;
    }

    // Fallback to stratifierstats if poolstats not available
    if (stratifier && pool.users === 0) {
        pool.users = getNestedValue(stratifier, 'users.count') || 0;
        pool.shares = getNestedValue(stratifier, 'shares.generated') ||
                      getNestedValue(stratifier, 'shares.count') || 0;
    }

    // Get connection count from connector stats
    if (connector) {
        pool.connections = getNestedValue(connector, 'clients.count') || 0;
        if (pool.workers === 0) {
            pool.workers = pool.connections;
        }
    }

    return pool;
}

function parseUserStats(raw) {
    if (!raw) return null;

    // Check for error response
    if (raw.error || raw === 'unknown' || (typeof raw === 'string' && raw.includes('error'))) {
        return null;
    }

    // getuser returns: user, id, workers, bestdiff, dsps1/5/60/1440/10080, lastshare
    const hashrate1m = (raw.dsps1 || 0) * NONCES_PER_SHARE;
    const hashrate5m = (raw.dsps5 || 0) * NONCES_PER_SHARE;
    const hashrate1h = (raw.dsps60 || 0) * NONCES_PER_SHARE;
    const hashrate1d = (raw.dsps1440 || 0) * NONCES_PER_SHARE;
    const hashrate7d = (raw.dsps10080 || 0) * NONCES_PER_SHARE;

    const lastShare = raw.lastshare || 0;
    const isIdle = lastShare > 0 && (Date.now() / 1000 - lastShare > 300);

    return {
        address: raw.user || raw.username || 'Unknown',
        id: raw.id || 0,
        hashrate: {
            current: hashrate1m,
            avg5m: hashrate5m,
            avg15m: 0, // Not provided by ckpool
            avg1h: hashrate1h,
            avg24h: hashrate1d,
            avg7d: hashrate7d
        },
        shares: {
            accepted: raw.shares || raw.accepted || 0,
            rejected: raw.rejected || 0,
            stale: raw.stale || 0
        },
        // Use bestever/bestshare (historical) over bestdiff (session-based)
        bestDiff: raw.bestever || raw.bestshare || raw.bestdiff || raw.best_diff || 0,
        lastShare: lastShare,
        workers: raw.worker || [],
        workerCount: raw.workers || 0,
        isIdle: isIdle,
        authorised: raw.authorised || 0
    };
}

function parseWorkerStats(raw) {
    if (!raw) return null;

    // Check for error response
    if (raw.error || raw === 'unknown') {
        return null;
    }

    // getworker returns similar data to getuser but for a specific worker
    const hashrate1m = (raw.dsps1 || 0) * NONCES_PER_SHARE;
    const hashrate5m = (raw.dsps5 || 0) * NONCES_PER_SHARE;
    const hashrate1h = (raw.dsps60 || 0) * NONCES_PER_SHARE;

    return {
        name: raw.worker || raw.workername || 'default',
        hashrate: hashrate1m,
        hashrate5m: hashrate5m,
        hashrate1h: hashrate1h,
        shares: raw.shares || 0,
        // Use bestever/bestshare (historical) over bestdiff (session-based)
        bestDiff: raw.bestever || raw.bestshare || raw.bestdiff || raw.best_diff || 0,
        lastShare: raw.lastshare || 0,
        isIdle: raw.idle || false
    };
}

// Parse user-agent string to identify miner type
function parseMinerType(useragent) {
    if (!useragent || useragent === '') {
        return { type: 'Unknown', name: 'Unknown Miner' };
    }

    const ua = useragent.toLowerCase();

    // NerdQaxe/NerdMiner variants
    if (ua.includes('nerdqaxe') || ua.includes('nerdaxe') || ua.includes('nerdminer')) {
        if (ua.includes('nerdqaxe++') || ua.includes('qaxe++')) return { type: 'NerdQaxe', name: 'NerdQaxe++' };
        if (ua.includes('nerdqaxe+') || ua.includes('qaxe+')) return { type: 'NerdQaxe', name: 'NerdQaxe+' };
        if (ua.includes('nerdqaxe')) return { type: 'NerdQaxe', name: 'NerdQaxe' };
        if (ua.includes('nerdaxe')) return { type: 'NerdAxe', name: 'NerdAxe' };
        return { type: 'NerdMiner', name: 'NerdMiner' };
    }

    // Bitaxe variants
    if (ua.includes('bitaxe') || ua.includes('esp-miner')) {
        if (ua.includes('ultra')) return { type: 'Bitaxe', name: 'Bitaxe Ultra' };
        if (ua.includes('max')) return { type: 'Bitaxe', name: 'Bitaxe Max' };
        if (ua.includes('hex')) return { type: 'Bitaxe', name: 'Bitaxe Hex' };
        if (ua.includes('supra')) return { type: 'Bitaxe', name: 'Bitaxe Supra' };
        if (ua.includes('gamma')) return { type: 'Bitaxe', name: 'Bitaxe Gamma' };
        return { type: 'Bitaxe', name: 'Bitaxe' };
    }

    // Bitmain Antminers
    if (ua.includes('antminer') || ua.includes('bitmain')) {
        if (ua.includes('s21')) return { type: 'Antminer', name: 'Antminer S21' };
        if (ua.includes('s19')) return { type: 'Antminer', name: 'Antminer S19' };
        if (ua.includes('t21')) return { type: 'Antminer', name: 'Antminer T21' };
        if (ua.includes('t19')) return { type: 'Antminer', name: 'Antminer T19' };
        if (ua.includes('s17')) return { type: 'Antminer', name: 'Antminer S17' };
        if (ua.includes('s15')) return { type: 'Antminer', name: 'Antminer S15' };
        if (ua.includes('s9')) return { type: 'Antminer', name: 'Antminer S9' };
        return { type: 'Antminer', name: 'Antminer' };
    }

    // MicroBT Whatsminer
    if (ua.includes('whatsminer') || ua.includes('microbt')) {
        if (ua.includes('m50')) return { type: 'Whatsminer', name: 'Whatsminer M50' };
        if (ua.includes('m30')) return { type: 'Whatsminer', name: 'Whatsminer M30' };
        if (ua.includes('m20')) return { type: 'Whatsminer', name: 'Whatsminer M20' };
        return { type: 'Whatsminer', name: 'Whatsminer' };
    }

    // Canaan Avalon
    if (ua.includes('avalon') || ua.includes('canaan')) {
        return { type: 'Avalon', name: 'Avalon' };
    }

    // Innosilicon
    if (ua.includes('innosilicon') || ua.includes('t2t') || ua.includes('t3')) {
        return { type: 'Innosilicon', name: 'Innosilicon' };
    }

    // Braiins/BOSminer
    if (ua.includes('braiins') || ua.includes('bosminer') || ua.includes('bos')) {
        return { type: 'Braiins', name: 'Braiins OS+' };
    }

    // CGMiner/BFGMiner (generic)
    if (ua.includes('cgminer')) {
        return { type: 'CGMiner', name: 'CGMiner' };
    }
    if (ua.includes('bfgminer')) {
        return { type: 'BFGMiner', name: 'BFGMiner' };
    }

    // NiceHash
    if (ua.includes('nicehash')) {
        return { type: 'NiceHash', name: 'NiceHash' };
    }

    // Firmware identifiers
    if (ua.includes('vnish')) {
        return { type: 'Vnish', name: 'Vnish Firmware' };
    }
    if (ua.includes('hiveon')) {
        return { type: 'Hiveon', name: 'Hiveon ASIC' };
    }
    if (ua.includes('luxos')) {
        return { type: 'LuxOS', name: 'LuxOS' };
    }

    // AxeOS (Bitaxe firmware)
    if (ua.includes('axeos')) {
        return { type: 'Bitaxe', name: 'AxeOS' };
    }

    // Return the raw useragent if unknown
    return { type: 'Other', name: useragent.slice(0, 20) };
}

// Parse client info to extract useful data
function parseClientInfo(clientData) {
    if (!clientData || !clientData.clients) {
        return [];
    }

    return clientData.clients.map(client => ({
        id: client.id || 0,
        workername: client.workername || 'default',
        useragent: client.useragent || '',
        miner: parseMinerType(client.useragent),
        diff: client.diff || 0,
        startdiff: client.startdiff || 0,
        // Use bestever/bestshare (historical) over bestdiff (session-based)
        bestdiff: client.bestever || client.bestshare || client.bestdiff || 0,
        dsps1: client.dsps1 || 0,
        rejected: client.rejected || 0,
        idle: client.idle || false,
        ip: client.ip || ''
    }));
}

// Aggregate miner types from client list (returns counts by type)
function aggregateMinerTypes(clientData) {
    if (!clientData || !clientData.clients || !Array.isArray(clientData.clients)) {
        return [];
    }

    const typeCounts = {};

    clientData.clients.forEach(client => {
        const miner = parseMinerType(client.useragent);
        const key = miner.name;
        if (!typeCounts[key]) {
            typeCounts[key] = { name: miner.name, type: miner.type, count: 0 };
        }
        typeCounts[key].count++;
    });

    // Convert to array and sort by count descending
    return Object.values(typeCounts).sort((a, b) => b.count - a.count);
}

module.exports = {
    formatHashrate,
    formatDifficulty,
    formatTimestamp,
    timeAgo,
    parseUserStats,
    parsePoolStats,
    parseWorkerStats,
    parseMinerType,
    parseClientInfo,
    aggregateMinerTypes,
    getNestedValue
};
