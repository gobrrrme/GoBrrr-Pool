// War Room persistent database (SQLite via better-sqlite3)
// Stores warrior profiles, zap events, spawn campaigns, weekly rewards, pool events
'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');

const DB_PATH = path.join(__dirname, '../data/warroom.db');
const ALGO    = 'aes-256-gcm';

// ── Encryption helpers ────────────────────────────────────────────────────────

function getKey() {
    const raw = process.env.DB_ENCRYPTION_KEY;
    if (!raw || raw.length !== 64) return null;
    return Buffer.from(raw, 'hex');
}

function encrypt(text) {
    if (!text) return null;
    const key = getKey();
    if (!key) {
        console.warn('[DB] DB_ENCRYPTION_KEY not set — storing LN address as plaintext');
        return text;
    }
    const iv       = crypto.randomBytes(12);
    const cipher   = crypto.createCipheriv(ALGO, key, iv);
    const enc      = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag      = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(blob) {
    if (!blob) return null;
    const key = getKey();
    if (!key) return blob;  // stored plaintext when no key
    try {
        const buf      = Buffer.from(blob, 'base64');
        const iv       = buf.slice(0, 12);
        const tag      = buf.slice(12, 28);
        const enc      = buf.slice(28);
        const decipher = crypto.createDecipheriv(ALGO, key, iv);
        decipher.setAuthTag(tag);
        return decipher.update(enc).toString('utf8') + decipher.final('utf8');
    } catch {
        return null;
    }
}

// ── DB init ───────────────────────────────────────────────────────────────────

let _db = null;

function getDb() {
    if (_db) return _db;
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    initSchema(_db);
    return _db;
}

function initSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS warriors (
            worker_name   TEXT    PRIMARY KEY,
            side          TEXT,
            ln_address    TEXT,
            xp            INTEGER NOT NULL DEFAULT 0,
            level         INTEGER NOT NULL DEFAULT 1,
            total_shares  REAL    NOT NULL DEFAULT 0,
            weekly_shares REAL    NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL,
            last_active   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS zap_events (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            from_worker  TEXT,
            to_worker    TEXT    NOT NULL,
            amount_sats  INTEGER NOT NULL,
            payment_hash TEXT,
            created_at   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS spawn_campaigns (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            name         TEXT    NOT NULL,
            device_type  TEXT    NOT NULL,
            side         TEXT    NOT NULL,
            target_sats  INTEGER NOT NULL,
            funded_sats  INTEGER NOT NULL DEFAULT 0,
            lnurl_pay    TEXT,
            wallet_id    TEXT,
            invoice_key  TEXT,
            status       TEXT    NOT NULL DEFAULT 'active',
            created_at   INTEGER NOT NULL,
            funded_at    INTEGER
        );

        CREATE TABLE IF NOT EXISTS weekly_rewards (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            week_start    INTEGER NOT NULL,
            side          TEXT    NOT NULL,
            winner_worker TEXT    NOT NULL,
            amount_sats   INTEGER NOT NULL,
            payment_hash  TEXT,
            status        TEXT    NOT NULL,
            created_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pool_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            type        TEXT    NOT NULL,
            worker      TEXT,
            amount_sats INTEGER,
            description TEXT,
            created_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS zap_payouts (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_hash   TEXT    UNIQUE NOT NULL,
            to_worker      TEXT    NOT NULL,
            amount_sats    INTEGER NOT NULL,
            payout_sats    INTEGER NOT NULL,
            fee_sats       INTEGER NOT NULL,
            status         TEXT    NOT NULL DEFAULT 'pending',
            attempts       INTEGER NOT NULL DEFAULT 0,
            last_error     TEXT,
            created_at     INTEGER NOT NULL,
            paid_at        INTEGER
        );
    `);

    // ── Indexes (CREATE IF NOT EXISTS — safe to run every boot) ──────────────
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_warriors_side        ON warriors(side);
        CREATE INDEX IF NOT EXISTS idx_warriors_last_active ON warriors(last_active);
        CREATE INDEX IF NOT EXISTS idx_warriors_xp          ON warriors(xp DESC);
        CREATE INDEX IF NOT EXISTS idx_pool_events_ts       ON pool_events(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_zap_payouts_status   ON zap_payouts(status);
    `);
}

// ── Config (encrypted key/value store) ───────────────────────────────────────

function setConfig(key, value) {
    const db = getDb();
    if (value === null || value === undefined || value === '') {
        db.prepare('DELETE FROM config WHERE key = ?').run(key);
    } else {
        db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, encrypt(value));
    }
}

function getConfig(key) {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row ? decrypt(row.value) : null;
}

function getConfigAll() {
    return getDb().prepare('SELECT key, value FROM config').all()
        .reduce((acc, r) => { acc[r.key] = decrypt(r.value); return acc; }, {});
}

// ── Warriors ──────────────────────────────────────────────────────────────────

function upsertWarrior({ workerName, side, lnAddress }) {
    const db  = getDb();
    const now = Math.floor(Date.now() / 1000);
    const existing = db.prepare('SELECT * FROM warriors WHERE worker_name = ?').get(workerName);

    if (!existing) {
        db.prepare(`
            INSERT INTO warriors (worker_name, side, ln_address, xp, level, total_shares, weekly_shares, created_at, last_active)
            VALUES (?, ?, ?, 0, 1, 0, 0, ?, ?)
        `).run(workerName, side || null, lnAddress ? encrypt(lnAddress) : null, now, now);
    } else {
        const sets  = ['last_active = ?'];
        const params = [now];
        if (side && side !== existing.side) { sets.push('side = ?'); params.push(side); }
        if (lnAddress !== undefined) {
            sets.push('ln_address = ?');
            params.push(lnAddress ? encrypt(lnAddress) : null);
        }
        params.push(workerName);
        db.prepare(`UPDATE warriors SET ${sets.join(', ')} WHERE worker_name = ?`).run(...params);
    }
}

function getWarrior(workerName) {
    const row = getDb().prepare('SELECT * FROM warriors WHERE worker_name = ?').get(workerName);
    if (!row) return null;
    return { ...row, ln_address: row.ln_address ? decrypt(row.ln_address) : null };
}

function getWarriorsBySide(side) {
    return getDb()
        .prepare('SELECT * FROM warriors WHERE side = ? ORDER BY xp DESC')
        .all(side)
        .map(r => ({ ...r, ln_address: r.ln_address ? decrypt(r.ln_address) : null }));
}

function addXP(workerName, amount) {
    if (!amount || amount <= 0) return;
    const db = getDb();
    db.prepare('UPDATE warriors SET xp = xp + ? WHERE worker_name = ?').run(amount, workerName);
    const row = db.prepare('SELECT xp FROM warriors WHERE worker_name = ?').get(workerName);
    if (row) {
        const newLevel = computeLevel(row.xp);
        db.prepare('UPDATE warriors SET level = ? WHERE worker_name = ?').run(newLevel, workerName);
    }
}

function addShares(workerName, shareWeight) {
    if (!shareWeight || shareWeight <= 0) return;
    getDb().prepare(`
        UPDATE warriors SET total_shares = total_shares + ?, weekly_shares = weekly_shares + ?
        WHERE worker_name = ?
    `).run(shareWeight, shareWeight, workerName);
}

function resetWeeklyShares(side) {
    getDb().prepare('UPDATE warriors SET weekly_shares = 0 WHERE side = ?').run(side);
}

function getTopWarriorByWeeklyShares(side) {
    const row = getDb()
        .prepare('SELECT * FROM warriors WHERE side = ? ORDER BY weekly_shares DESC LIMIT 1')
        .get(side);
    if (!row) return null;
    return { ...row, ln_address: row.ln_address ? decrypt(row.ln_address) : null };
}

function getAllActiveWarriors(sinceSeconds = 600) {
    const cutoff = Math.floor(Date.now() / 1000) - sinceSeconds;
    return getDb()
        .prepare('SELECT worker_name, side, xp FROM warriors WHERE last_active >= ?')
        .all(cutoff);
}

// ── Zap payouts (invoice-based, with retry support) ───────────────────────────

function insertZapPayout({ invoiceHash, toWorker, amountSats, payoutSats, feeSats }) {
    getDb().prepare(`
        INSERT OR IGNORE INTO zap_payouts
            (invoice_hash, to_worker, amount_sats, payout_sats, fee_sats, status, attempts, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)
    `).run(invoiceHash, toWorker, amountSats, payoutSats, feeSats, Math.floor(Date.now() / 1000));
}

function markZapPayoutPaid(invoiceHash) {
    getDb().prepare(`
        UPDATE zap_payouts SET status = 'paid', paid_at = ?, last_error = NULL
        WHERE invoice_hash = ?
    `).run(Math.floor(Date.now() / 1000), invoiceHash);
}

function markZapPayoutAttempted(invoiceHash, error) {
    getDb().prepare(`
        UPDATE zap_payouts SET attempts = attempts + 1, last_error = ?
        WHERE invoice_hash = ?
    `).run(error, invoiceHash);
}

function getPendingZapPayouts() {
    return getDb().prepare(`
        SELECT * FROM zap_payouts WHERE status = 'pending' ORDER BY created_at ASC
    `).all();
}

// ── Zaps ──────────────────────────────────────────────────────────────────────

function recordZap({ fromWorker, toWorker, amountSats, paymentHash }) {
    getDb().prepare(`
        INSERT INTO zap_events (from_worker, to_worker, amount_sats, payment_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(fromWorker || null, toWorker, amountSats, paymentHash || null, Math.floor(Date.now() / 1000));
}

// ── Weekly rewards ────────────────────────────────────────────────────────────

function recordReward({ weekStart, side, winnerWorker, amountSats, paymentHash, status }) {
    getDb().prepare(`
        INSERT INTO weekly_rewards (week_start, side, winner_worker, amount_sats, payment_hash, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(weekStart, side, winnerWorker, amountSats, paymentHash || null, status, Math.floor(Date.now() / 1000));
}

// ── Pool events ───────────────────────────────────────────────────────────────

function addEvent({ type, worker, amountSats, description }) {
    getDb().prepare(`
        INSERT INTO pool_events (type, worker, amount_sats, description, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(type, worker || null, amountSats || null, description || null, Math.floor(Date.now() / 1000));
}

function getRecentEvents(limit = 20) {
    return getDb()
        .prepare('SELECT * FROM pool_events ORDER BY created_at DESC LIMIT ?')
        .all(limit);
}

// ── Spawn campaigns ───────────────────────────────────────────────────────────

function createCampaign({ name, deviceType, side, targetSats }) {
    const db  = getDb();
    const now = Math.floor(Date.now() / 1000);
    const result = db.prepare(`
        INSERT INTO spawn_campaigns (name, device_type, side, target_sats, funded_sats, status, created_at)
        VALUES (?, ?, ?, ?, 0, 'active', ?)
    `).run(name, deviceType, side, targetSats, now);
    return result.lastInsertRowid;
}

function updateCampaignLnurl(id, { lnurlPay, walletId, invoiceKey }) {
    getDb().prepare(`
        UPDATE spawn_campaigns SET lnurl_pay = ?, wallet_id = ?, invoice_key = ? WHERE id = ?
    `).run(lnurlPay || null, walletId || null, invoiceKey || null, id);
}

function getCampaigns() {
    return getDb().prepare('SELECT * FROM spawn_campaigns ORDER BY created_at DESC').all();
}

function getCampaign(id) {
    return getDb().prepare('SELECT * FROM spawn_campaigns WHERE id = ?').get(id);
}

function addFundsToCampaign(id, sats) {
    const db = getDb();
    db.prepare('UPDATE spawn_campaigns SET funded_sats = funded_sats + ? WHERE id = ?').run(sats, id);
    const c = db.prepare('SELECT * FROM spawn_campaigns WHERE id = ?').get(id);
    if (c && c.funded_sats >= c.target_sats && c.status === 'active') {
        db.prepare("UPDATE spawn_campaigns SET status = 'funded', funded_at = ? WHERE id = ?")
            .run(Math.floor(Date.now() / 1000), id);
        console.log(`[SPAWN] Campaign "${c.name}" fully funded! Admin: plug in the device.`);
        addEvent({ type: 'spawn_funded', description: `Campaign "${c.name}" fully funded!` });
    }
}

// ── Level computation ─────────────────────────────────────────────────────────

const LEVELS = [
    { level: 1, threshold: 0 },     { level: 2, threshold: 100 },
    { level: 3, threshold: 300 },   { level: 4, threshold: 600 },
    { level: 5, threshold: 1000 },  { level: 6, threshold: 1500 },
    { level: 7, threshold: 2100 },  { level: 8, threshold: 2800 },
    { level: 9, threshold: 3600 },  { level: 10, threshold: 4500 },
];

function computeLevel(xpVal) {
    let level = 1;
    for (const l of LEVELS) {
        if (xpVal >= l.threshold) level = l.level;
        else break;
    }
    return level;
}

module.exports = {
    getDb,
    encrypt,
    decrypt,
    // Config
    setConfig,
    getConfig,
    getConfigAll,
    // Warriors
    upsertWarrior,
    getWarrior,
    getWarriorsBySide,
    addXP,
    addShares,
    resetWeeklyShares,
    getTopWarriorByWeeklyShares,
    getAllActiveWarriors,
    // Zap payouts
    insertZapPayout,
    markZapPayoutPaid,
    markZapPayoutAttempted,
    getPendingZapPayouts,
    // Zaps
    recordZap,
    // Weekly rewards
    recordReward,
    // Pool events
    addEvent,
    getRecentEvents,
    // Spawn campaigns
    createCampaign,
    updateCampaignLnurl,
    getCampaigns,
    getCampaign,
    addFundsToCampaign,
    // Util
    computeLevel,
};
