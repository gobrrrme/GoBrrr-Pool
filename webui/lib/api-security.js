// API Security Middleware
const crypto = require('crypto');

// Generate a unique token for this server instance
const API_TOKEN = crypto.randomBytes(32).toString('hex');

// Simple rate limiting store (in production, use Redis)
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 120; // Max requests per window

// Clean up old rate limit entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, data] of rateLimitStore.entries()) {
        if (now - data.windowStart > RATE_LIMIT_WINDOW * 2) {
            rateLimitStore.delete(key);
        }
    }
}, RATE_LIMIT_WINDOW);

// Rate limiting middleware
function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();

    let data = rateLimitStore.get(ip);
    if (!data || now - data.windowStart > RATE_LIMIT_WINDOW) {
        data = { windowStart: now, count: 0 };
    }

    data.count++;
    rateLimitStore.set(ip, data);

    if (data.count > RATE_LIMIT_MAX) {
        return res.status(429).json({
            success: false,
            error: 'Too many requests. Please slow down.'
        });
    }

    next();
}

// API protection middleware - ensures requests come from our WebUI
function protectApi(req, res, next) {
    // Allow health checks
    if (req.path === '/health') {
        return next();
    }

    // Check for required custom header (prevents direct browser access)
    const poolHeader = req.headers['x-pool-request'];
    if (poolHeader !== 'internal') {
        return res.status(403).json({
            success: false,
            error: 'Direct API access not allowed'
        });
    }

    // Check for valid token
    const token = req.headers['x-pool-token'];
    if (token !== API_TOKEN) {
        return res.status(403).json({
            success: false,
            error: 'Invalid or missing API token'
        });
    }

    // Check Origin/Referer header (same-origin check)
    const origin = req.headers.origin || '';
    const referer = req.headers.referer || '';
    const host = req.headers.host || '';

    // Allow if origin/referer matches host or is empty (same-origin requests)
    const isValidOrigin = !origin ||
        origin.includes(host) ||
        origin.includes('localhost') ||
        origin.includes('127.0.0.1');

    const isValidReferer = !referer ||
        referer.includes(host) ||
        referer.includes('localhost') ||
        referer.includes('127.0.0.1');

    if (!isValidOrigin && !isValidReferer) {
        return res.status(403).json({
            success: false,
            error: 'Cross-origin requests not allowed'
        });
    }

    next();
}

// Middleware to inject API token into pages
function injectToken(req, res, next) {
    res.locals.apiToken = API_TOKEN;
    next();
}

// Get the current token (for embedding in pages)
function getToken() {
    return API_TOKEN;
}

module.exports = {
    rateLimit,
    protectApi,
    injectToken,
    getToken,
    API_TOKEN
};
