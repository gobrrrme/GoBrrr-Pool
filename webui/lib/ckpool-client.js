const net = require('net');
const fs = require('fs');
const path = require('path');

const SOCKET_DIR = process.env.CKPOOL_SOCKET_DIR || '/tmp/ckpool';
const SOCKET_TIMEOUT = 5000;

class CKPoolClient {
    constructor() {
        // Listener socket for stratifierstats/connectorstats
        this.listenerSocket = path.join(SOCKET_DIR, 'listener');
        // Stratifier socket for API commands (poolstats, users, getuser, etc.)
        this.stratifierSocket = path.join(SOCKET_DIR, 'stratifier');
        console.log(`CKPool client initialized with sockets:`);
        console.log(`  - listener: ${this.listenerSocket}`);
        console.log(`  - stratifier: ${this.stratifierSocket}`);
    }

    // CKPool protocol: 4 bytes (uint32 LE) length prefix + message
    sendCommand(command, socketPath = null) {
        const socket = socketPath || this.listenerSocket;
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(socket)) {
                reject(new Error(`Socket not found: ${socket}`));
                return;
            }

            const client = net.createConnection(socket);
            let responseBuffer = Buffer.alloc(0);
            let expectedLength = null;
            let resolved = false;

            client.setTimeout(SOCKET_TIMEOUT);

            client.on('connect', () => {
                const msgBuffer = Buffer.from(command, 'utf8');
                const lengthBuffer = Buffer.alloc(4);
                lengthBuffer.writeUInt32LE(msgBuffer.length, 0);
                client.write(Buffer.concat([lengthBuffer, msgBuffer]));
            });

            client.on('data', (chunk) => {
                responseBuffer = Buffer.concat([responseBuffer, chunk]);

                if (expectedLength === null && responseBuffer.length >= 4) {
                    expectedLength = responseBuffer.readUInt32LE(0);
                    responseBuffer = responseBuffer.slice(4);
                }

                if (expectedLength !== null && responseBuffer.length >= expectedLength) {
                    const message = responseBuffer.slice(0, expectedLength).toString('utf8');

                    if (!resolved) {
                        resolved = true;
                        client.end();

                        try {
                            resolve(JSON.parse(message));
                        } catch (e) {
                            resolve(message);
                        }
                    }
                }
            });

            client.on('end', () => {
                if (!resolved && responseBuffer.length > 0) {
                    resolved = true;
                    try {
                        resolve(JSON.parse(responseBuffer.toString('utf8')));
                    } catch (e) {
                        resolve(responseBuffer.toString('utf8'));
                    }
                } else if (!resolved) {
                    reject(new Error('Connection closed without response'));
                }
            });

            client.on('error', (err) => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error(`Socket error: ${err.message}`));
                }
            });

            client.on('timeout', () => {
                if (!resolved) {
                    resolved = true;
                    client.destroy();
                    reject(new Error('Socket timeout'));
                }
            });

            client.on('close', () => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error('Connection closed'));
                }
            });
        });
    }

    async getPoolStats() {
        try {
            // Use poolstats API on stratifier socket for real mining stats
            // Falls back to stratifierstats if poolstats fails
            let poolstats = null;
            try {
                poolstats = await this.sendCommand('poolstats', this.stratifierSocket);
                console.log('poolstats response:', JSON.stringify(poolstats, null, 2));
            } catch (err) {
                console.log('poolstats failed, falling back to stratifierstats:', err.message);
            }

            // Also get stratifierstats for additional data
            const [stratifier, connector] = await Promise.all([
                this.sendCommand('stratifierstats', this.listenerSocket),
                this.sendCommand('connectorstats', this.listenerSocket)
            ]);

            return { poolstats, stratifier, connector, timestamp: Date.now() };
        } catch (err) {
            console.error('Failed to get pool stats:', err.message);
            return { poolstats: null, stratifier: null, connector: null, timestamp: Date.now() };
        }
    }

    async getUserStats(btcAddress) {
        try {
            // Use getuser API on stratifier socket
            // Format: getuser.{"user":"address"}
            const command = `getuser.${JSON.stringify({user: btcAddress})}`;
            console.log(`Sending getuser command: ${command}`);
            const userStats = await this.sendCommand(command, this.stratifierSocket);
            console.log(`User stats for ${btcAddress}:`, JSON.stringify(userStats, null, 2));
            return userStats;
        } catch (err) {
            console.error(`Failed to get user stats for ${btcAddress}:`, err.message);
            return null;
        }
    }

    async getWorkerStats(btcAddress, workerName) {
        try {
            // Format: getworker.{"worker":"username.workername"}
            const workerFullName = workerName ? `${btcAddress}.${workerName}` : btcAddress;
            const command = `getworker.${JSON.stringify({worker: workerFullName})}`;
            console.log(`Sending getworker command: ${command}`);
            const workerStats = await this.sendCommand(command, this.stratifierSocket);
            console.log(`Worker stats for ${workerFullName}:`, JSON.stringify(workerStats, null, 2));
            return workerStats;
        } catch (err) {
            console.error(`Failed to get worker stats:`, err.message);
            return null;
        }
    }

    async getAllUsers() {
        try {
            const users = await this.sendCommand('users', this.stratifierSocket);
            console.log('All users:', JSON.stringify(users, null, 2));
            return users;
        } catch (err) {
            console.error('Failed to get users list:', err.message);
            return null;
        }
    }

    async getAllWorkers() {
        try {
            const workers = await this.sendCommand('workers', this.stratifierSocket);
            console.log('All workers:', JSON.stringify(workers, null, 2));
            return workers;
        } catch (err) {
            console.error('Failed to get workers list:', err.message);
            return null;
        }
    }

    async getUserClients(btcAddress) {
        try {
            // Format: ucinfo.{"user":"address"}
            // Returns client info including useragent for all clients of this user
            const command = `ucinfo.${JSON.stringify({user: btcAddress})}`;
            console.log(`Sending ucinfo command: ${command}`);
            const clientInfo = await this.sendCommand(command, this.stratifierSocket);
            console.log(`Client info for ${btcAddress}:`, JSON.stringify(clientInfo, null, 2));
            return clientInfo;
        } catch (err) {
            console.error(`Failed to get client info for ${btcAddress}:`, err.message);
            return null;
        }
    }

    async getWorkerClients(workerFullName) {
        try {
            // Format: wcinfo.{"worker":"username.workername"}
            // Returns client info including useragent for this specific worker
            const command = `wcinfo.${JSON.stringify({worker: workerFullName})}`;
            console.log(`Sending wcinfo command: ${command}`);
            const clientInfo = await this.sendCommand(command, this.stratifierSocket);
            console.log(`Client info for ${workerFullName}:`, JSON.stringify(clientInfo, null, 2));
            return clientInfo;
        } catch (err) {
            console.error(`Failed to get worker client info:`, err.message);
            return null;
        }
    }

    async getStratifierStats() {
        try {
            return await this.sendCommand('stratifierstats', this.listenerSocket);
        } catch (err) {
            console.error('Failed to get stratifier stats:', err.message);
            return null;
        }
    }

    async getConnectorStats() {
        try {
            return await this.sendCommand('connectorstats', this.listenerSocket);
        } catch (err) {
            console.error('Failed to get connector stats:', err.message);
            return null;
        }
    }

    async getAllClients() {
        try {
            // Get all connected clients with their info
            const clients = await this.sendCommand('clients', this.stratifierSocket);
            console.log('All clients:', JSON.stringify(clients, null, 2));
            return clients;
        } catch (err) {
            console.error('Failed to get clients list:', err.message);
            return null;
        }
    }
}

module.exports = new CKPoolClient();
