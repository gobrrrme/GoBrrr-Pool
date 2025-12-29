# Go Brrr Pool

A modern, feature-rich WebUI for [ckpool-solo](https://bitbucket.org/ckolivas/ckpool-solo/) Bitcoin mining pool. Designed for solo miners who want to run their own pool with a clean, responsive interface.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Docker](https://img.shields.io/badge/docker-ready-brightgreen.svg)

## Overview

Go Brrr Pool consists of two main components:

### 1. CKPool-Solo (Backend)
The battle-tested solo mining pool software by Con Kolivas. Handles all stratum protocol communication with miners.

- High-performance C implementation
- Stratum protocol support
- ZMQ support for instant block notifications
- Unix socket interface for stats
- Automatic difficulty adjustment

### 2. WebUI (Frontend)
A custom Node.js/Express web interface providing real-time pool monitoring and statistics.

- Real-time pool and network statistics
- Worker lookup and monitoring
- Miner type detection (Bitaxe, Antminer, etc.)
- Leaderboard with best difficulties
- Mobile-responsive design
- Integration with mempool.space API

## Features

### Home Page
- **Bitcoin Network Stats**: Block height, network hashrate, difficulty, BTC price
- **Pool Statistics**: Hashrate, workers, users, best difficulty
- **Recent Blocks**: Latest blocks with miner attribution
- **Leaderboard**: Top miners by best difficulty with online/offline indicators
- **Pool Hashrate Chart**: Visual hashrate history
- **Stratum Connection Info**: Dynamic hostname display

### Worker Lookup
- Hashrate averages (1m, 5m, 1h, 24h, 7d)
- Share statistics (accepted, rejected, stale)
- Connected miners with:
  - Individual hashrate
  - Miner type detection
  - Current difficulty
  - Best difficulty achieved
  - Online status

### Pool Stats Page
- Detailed hashrate breakdowns
- Network statistics
- Mining performance metrics
- Share efficiency

### Efficiency Dashboard
- Network share percentage
- Expected block time
- Daily block probability
- Revenue estimation
- Fee market analysis

### Additional Features
- **Drag-and-drop**: Reorder dashboard cards (saved to localStorage)
- **Miner Type Detection**: Identifies hardware from user agents (Bitaxe, Antminer, Whatsminer, etc.)
- **Historical Miner Cache**: Remembers miner types even after disconnect
- **Mobile Responsive**: Optimized for all screen sizes
- **Dark Theme**: Easy on the eyes for 24/7 monitoring

## Project Structure

```
mining-pool/
├── ckpool/
│   ├── src/                    # CKPool source code
│   ├── Dockerfile              # CKPool container build
│   └── docker-entrypoint.sh    # Startup script
├── webui/
│   ├── lib/
│   │   ├── ckpool-client.js    # Unix socket communication
│   │   ├── stats-parser.js     # Data parsing & formatting
│   │   └── miner-cache.js      # Persistent miner type storage
│   ├── routes/
│   │   ├── index.js            # Page routes
│   │   └── api.js              # API endpoints
│   ├── views/
│   │   ├── layout.ejs          # Base template
│   │   ├── index.ejs           # Home page
│   │   ├── stats.ejs           # Worker lookup
│   │   ├── pool.ejs            # Pool statistics
│   │   └── dashboard.ejs       # Efficiency dashboard
│   ├── public/
│   │   ├── css/style.css       # Styles
│   │   ├── js/main.js          # Frontend JavaScript
│   │   └── images/             # Assets
│   ├── server.js               # Express server
│   └── Dockerfile              # WebUI container build
├── docker-compose.yml          # Container orchestration
├── .env.example                # Configuration template
└── .env.secrets.example        # Secrets template
```

## Requirements

- Docker & Docker Compose
- Bitcoin Core node (local or remote)
- Port 3333 open for stratum connections
- Port 3000 (or custom) for WebUI

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/go-brrr-pool.git
cd go-brrr-pool
```

### 2. Configure Environment

```bash
# Copy example configurations
cp .env.example .env

# Create secrets directory
sudo mkdir -p /etc/ckpool
sudo chown $USER:$USER /etc/ckpool
sudo chmod 700 /etc/ckpool

# Copy and edit secrets
cp .env.secrets.example /etc/ckpool/.env.secrets
chmod 600 /etc/ckpool/.env.secrets
nano /etc/ckpool/.env.secrets
```

### 3. Edit Configuration

**.env** - Main configuration:
```bash
# Bitcoin RPC connection
BITCOIN_RPC_HOST=192.168.1.100  # Your bitcoind IP
BITCOIN_RPC_PORT=8332

# Pool settings
POOL_BTC_ADDRESS=bc1q...        # Your Bitcoin address for rewards
STRATUM_PORT=3333
START_DIFFICULTY=128            # Starting difficulty for miners
MIN_DIFFICULTY=1

# ZMQ for instant block notifications (recommended)
BITCOIN_ZMQ_HASHBLOCK=tcp://192.168.1.100:28332

# WebUI settings
WEBUI_PORT=3000
NODE_ENV=production

# Optional: Custom mempool API (default: mempool.space)
MEMPOOL_API_URL=https://mempool.space/api
```

**/etc/ckpool/.env.secrets** - Sensitive credentials:
```bash
BITCOIN_RPC_USER=your_rpc_username
BITCOIN_RPC_PASS=your_rpc_password
```

### 4. Configure Bitcoin Core

Add to your `bitcoin.conf`:
```ini
# RPC settings
server=1
rpcuser=your_rpc_username
rpcpassword=your_rpc_password
rpcallowip=172.16.0.0/12       # Docker network
rpcallowip=192.168.0.0/16      # Local network

# Optional but recommended
txindex=1
zmqpubhashblock=tcp://0.0.0.0:28332
```

### 5. Build and Start

```bash
# Build containers
docker compose build

# Start the pool
docker compose up -d

# View logs
docker logs -f gobrrrpool    # CKPool logs
docker logs -f poolwebui     # WebUI logs
```

### 6. Access the WebUI

Open `http://your-server-ip:3000` in your browser.

## Connecting Miners

Configure your miners with:

| Setting | Value |
|---------|-------|
| **Pool URL** | `stratum+tcp://your-server:3333` |
| **Username** | Your Bitcoin address (e.g., `bc1q...`) |
| **Password** | `x` (anything works) |
| **Worker Name** | Optional: `bc1q....workername` |

Example for Bitaxe:
```
Stratum URL: your-server
Port: 3333
Username: bc1qYourAddressHere.bitaxe1
Password: x
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/pool` | Pool statistics |
| `GET /api/network` | Bitcoin network stats |
| `GET /api/stats/:address` | Worker stats by BTC address |
| `GET /api/leaderboard` | Top miners by best difficulty |
| `GET /api/efficiency` | Efficiency metrics |
| `GET /api/price` | Current BTC price |
| `GET /api/blocks/recent` | Recent network blocks |

## Customization

### ZMQ Block Notifications

ZMQ enables instant block notifications from bitcoind to ckpool, ensuring miners switch to the new block template immediately when a block is found. Without ZMQ, ckpool polls for new blocks which adds latency.

**Bitcoin Core configuration** (`bitcoin.conf`):
```ini
zmqpubhashblock=tcp://0.0.0.0:28332
```

**Pool configuration** (`.env`):
```bash
BITCOIN_ZMQ_HASHBLOCK=tcp://192.168.1.100:28332
```

Replace `192.168.1.100` with your bitcoind IP address.

### Adding a High-Difficulty Port

Edit the ckpool configuration to add a second port for ASICs:

```json
{
    "serverurl": [
        "0.0.0.0:3333",
        "0.0.0.0:3334"
    ],
    "update": [
        {
            "serverurl": "0.0.0.0:3334",
            "mindiff": 10000,
            "startdiff": 50000
        }
    ]
}
```

### Custom Mempool API

For privacy or if running your own mempool instance:

```bash
MEMPOOL_API_URL=http://your-mempool:8999/api
```

### Reverse Proxy (nginx)

```nginx
server {
    listen 80;
    server_name pool.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Troubleshooting

### Pool shows no hashrate
- Check if miners are connected: `docker logs gobrrrpool`
- Verify stratum port is open: `nc -zv your-server 3333`
- Check Bitcoin RPC connection in logs

### WebUI not loading
- Check container status: `docker ps`
- View logs: `docker logs poolwebui`
- Verify socket connection between containers

### Miner types showing as "Unknown"
- Miner type detection is based on user agent strings
- Some miners may not send identifying information
- Historical types are cached after first detection

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## Credits

- [ckpool-solo](https://bitbucket.org/ckolivas/ckpool-solo/) by Con Kolivas
- [mempool.space](https://mempool.space/) for network data API
- Bitcoin icon from [Bitcoin Design](https://bitcoin.design/)

## License

MIT License - See [LICENSE](LICENSE) for details.

## Disclaimer

This software is provided as-is. Solo mining is a game of chance - you may mine for extended periods without finding a block. Only mine with resources you can afford to run without guaranteed returns.

---

**Go Brrr Pool** - Making Bitcoin mining fun again!
