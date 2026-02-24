const express = require('express');
const path = require('path');
const expressLayouts = require('express-ejs-layouts');

const indexRoutes = require('./routes/index');
const apiRoutes = require('./routes/api');
const { rateLimit, protectApi, injectToken } = require('./lib/api-security');
const minerCache = require('./lib/miner-cache');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (for correct IP in rate limiting behind nginx)
app.set('trust proxy', 1);

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// EJS Layouts
app.use(expressLayouts);
app.set('layout', 'layout');

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// JSON parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Inject API token into all rendered pages
app.use(injectToken);

// Routes
app.use('/', indexRoutes);

// API routes with protection
app.use('/api', rateLimit, protectApi, apiRoutes);

// Error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('error', {
        message: 'Something went wrong!',
        error: process.env.NODE_ENV === 'development' ? err : {}
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).render('error', {
        message: 'Page not found',
        error: {}
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`CKPool WebUI running on http://0.0.0.0:${PORT}`);
});

// Prune inactive leaderboard entries daily
// First run 1h after startup to avoid noise during initial cache warm-up
setTimeout(() => {
    minerCache.pruneInactiveWorkers();
    setInterval(() => minerCache.pruneInactiveWorkers(), 86400000);
}, 3600000);
