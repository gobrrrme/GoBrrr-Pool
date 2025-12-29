#!/bin/bash
set -e

# Clean up stale socket and PID files from previous runs
# This prevents "Process main pid X still exists" errors on container restart
echo "Cleaning up stale socket/PID files..."
rm -f /tmp/ckpool/main.pid /tmp/ckpool/*.sock 2>/dev/null || true
rm -f /var/log/ckpool/*.pid 2>/dev/null || true

# Ensure directories exist with correct permissions
mkdir -p /tmp/ckpool /var/log/ckpool /etc/ckpool
chmod 755 /tmp/ckpool /var/log/ckpool

# Build ZMQ config if ZMQ endpoint is provided
ZMQ_CONFIG=""
if [ -n "${BITCOIN_ZMQ_HASHBLOCK}" ]; then
    ZMQ_CONFIG="\"zmqblock\": \"${BITCOIN_ZMQ_HASHBLOCK}\","
    echo "ZMQ block notifications enabled: ${BITCOIN_ZMQ_HASHBLOCK}"
fi

# Build optional donation config
DONATION_CONFIG=""
if [ -n "${POOL_DONATION}" ] && [ "${POOL_DONATION}" != "0" ]; then
    DONATION_CONFIG="\"donation\": ${POOL_DONATION},"
fi

# Build optional signature config
BTCSIG_CONFIG=""
if [ -n "${POOL_SIGNATURE}" ]; then
    BTCSIG_CONFIG="\"btcsig\": \"${POOL_SIGNATURE}\","
fi

# Build secondary node config if provided
SECONDARY_NODE_CONFIG=""
if [ -n "${BITCOIN_RPC_HOST_2}" ]; then
    SECONDARY_NODE_CONFIG=",
        {
            \"url\": \"${BITCOIN_RPC_HOST_2}:${BITCOIN_RPC_PORT_2:-8332}\",
            \"auth\": \"${BITCOIN_RPC_USER_2:-${BITCOIN_RPC_USER:-rpcuser}}\",
            \"pass\": \"${BITCOIN_RPC_PASS_2:-${BITCOIN_RPC_PASS:-rpcpassword}}\",
            \"notify\": true
        }"
    echo "Secondary Bitcoin node configured: ${BITCOIN_RPC_HOST_2}"
fi

# Generate ckpool.conf for SOLO MINING mode with ULTRA-LOW LATENCY settings
# Note: btcaddress is NOT used in solo mode (-B flag)
# Each worker sends their own Bitcoin address as the stratum username
cat > /etc/ckpool/ckpool.conf << EOF
{
    "btcd": [
        {
            "url": "${BITCOIN_RPC_HOST:-localhost}:${BITCOIN_RPC_PORT:-8332}",
            "auth": "${BITCOIN_RPC_USER:-rpcuser}",
            "pass": "${BITCOIN_RPC_PASS:-rpcpassword}",
            "notify": true
        }${SECONDARY_NODE_CONFIG}
    ],
    ${DONATION_CONFIG}
    ${BTCSIG_CONFIG}
    ${ZMQ_CONFIG}
    "serverurl": [
        "${STRATUM_BIND:-0.0.0.0}:3333"
    ],
    "mindiff": ${MIN_DIFFICULTY:-1},
    "startdiff": ${START_DIFFICULTY:-10000},
    "maxdiff": ${MAX_DIFFICULTY:-0},
    "blockpoll": ${BLOCKPOLL:-50},
    "update_interval": ${UPDATE_INTERVAL:-20},
    "nonce1length": ${NONCE1_LENGTH:-4},
    "nonce2length": ${NONCE2_LENGTH:-8},
    "logdir": "/var/log/ckpool",
    "sockdir": "/tmp/ckpool"
}
EOF

echo "Generated ckpool.conf for SOLO MINING mode:"
# Show config without password
grep -v '"pass"' /etc/ckpool/ckpool.conf

echo ""
echo "Starting ckpool in solo mining mode (-B)..."
echo "Workers must connect with their Bitcoin address as username."

# Start ckpool in solo mode (-B)
# -k flag kills any existing instance (safety for restarts)
# -B flag enables BTC solo mining mode
exec /opt/ckpool/src/ckpool -B -k -c /etc/ckpool/ckpool.conf "$@"
