import axios from 'axios';
import { CONFIG } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { delay } from '../utils/helpers.js';

/**
 * Intelligent Load Balancer Service
 */
class LoadBalancer {
    constructor(serverManager) {
        this.serverManager = serverManager;
        this.roundRobinIndex = 0;
    }

    /**
     * Select optimal backend server
     * @returns {Promise<Object>} - Selected server
     */
    async selectOptimalServer() {
        const activeServers = this.serverManager.getActiveServers();
        
        if (activeServers.length === 0) {
            // Check if all servers are full
            const allServers = this.serverManager.getAllServers();
            const fullServers = allServers.filter(s => s.status === CONFIG.STATUS.FULL);
            
            if (fullServers.length === allServers.length && allServers.length > 0) {
                throw new Error('ALL_FULL');
            }
            
            // Check if all servers are unhealthy
            const unhealthyServers = allServers.filter(s => s.status === CONFIG.STATUS.UNHEALTHY);
            if (unhealthyServers.length === allServers.length && allServers.length > 0) {
                throw new Error('ALL_UNAVAILABLE');
            }
            
            throw new Error('NO_ACTIVE_SERVERS');
        }

        // Strategy 1: Get servers with least sessions
        const serverSessionPromises = activeServers.map(async (server) => {
            try {
                const sessionCount = await this.serverManager.getServerSessionCount(server.id);
                return { server, sessionCount };
            } catch (error) {
                logger.warn(`Failed to get session count for ${server.id}:`, {
                    error: error.message
                });
                return { server, sessionCount: Infinity };
            }
        });

        const serversWithSessions = await Promise.all(serverSessionPromises);
        
        // Filter out servers that are full
        const availableServers = serversWithSessions.filter(
            ({ sessionCount }) => sessionCount < CONFIG.MAX_SESSIONS_PER_SERVER
        );

        if (availableServers.length === 0) {
            throw new Error('ALL_FULL');
        }

        // Strategy 2: Find servers with minimum sessions
        const minSessions = Math.min(...availableServers.map(s => s.sessionCount));
        const leastLoadedServers = availableServers.filter(
            s => s.sessionCount === minSessions
        );

        // Strategy 3: If multiple servers have same session count, use round-robin
        if (leastLoadedServers.length > 1) {
            this.roundRobinIndex = (this.roundRobinIndex + 1) % leastLoadedServers.length;
            return leastLoadedServers[this.roundRobinIndex].server;
        }

        // Return the single least loaded server
        return leastLoadedServers[0].server;
    }

    /**
     * Forward request to backend server with retry logic
     * @param {Object} req - Express request object
     * @param {Object} server - Target server
     * @param {number} retries - Number of retries attempted
     * @returns {Promise<Object>} - Response from backend
     */
    async forwardRequest(req, server, retries = 0) {
        const { method, originalUrl, body, headers } = req;
        
        // VOTRE BACKEND ATTEND /pair/:num/ AVEC UN SLASH À LA FIN
        // On doit reconstruire l'URL correctement
        let path = originalUrl;
        if (originalUrl.match(/^\/pair\/[^\/]+$/)) {
            // Ajouter le slash final pour /pair/:number
            path = originalUrl + '/';
        }
        
        const targetUrl = `${server.url}${path}`;
        
        logger.info('Forwarding request to backend', {
            from: req.ip,
            to: server.id,
            originalUrl: originalUrl,
            targetUrl: targetUrl,
            retry: retries,
            number: req.params.number,
            sessionId: req.params.sessionId
        });

        try {
            const config = {
                method,
                url: targetUrl,
                headers: {
                    ...headers,
                    'x-forwarded-for': req.ip,
                    'x-proxy-server': server.id,
                    'x-proxy-timestamp': new Date().toISOString(),
                    'user-agent': 'Smart-Gateway-Proxy/1.0',
                    'accept': 'application/json'
                },
                timeout: CONFIG.REQUEST_TIMEOUT,
                validateStatus: function (status) {
                    return status >= 200 && status < 600; // Accept all status codes
                }
            };

            if (body && Object.keys(body).length > 0) {
                config.data = body;
                config.headers['content-type'] = 'application/json';
            }

            const response = await axios(config);
            
            logger.info('Backend response details', {
                server: server.id,
                status: response.status,
                statusText: response.statusText,
                duration: response.duration ? `${response.duration}ms` : 'unknown',
                url: targetUrl,
                responseData: response.data
            });

            return {
                data: response.data,
                status: response.status,
                headers: response.headers
            };
        } catch (error) {
            logger.error(`Request to ${server.id} failed:`, {
                error: error.message,
                code: error.code,
                retry: retries,
                url: targetUrl,
                stack: error.stack
            });

            // Mark server as unhealthy on certain errors
            if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
                this.serverManager.updateServerStatus(server.id, CONFIG.STATUS.UNHEALTHY, {
                    error: error.message
                });
            }

            // Retry logic
            if (retries < CONFIG.MAX_RETRIES) {
                await delay(CONFIG.RETRY_DELAY * (retries + 1));
                
                // Try to select a different server
                try {
                    const newServer = await this.selectOptimalServer();
                    logger.info(`Retrying with different server: ${newServer.id}`, {
                        originalServer: server.id,
                        retry: retries + 1
                    });
                    return this.forwardRequest(req, newServer, retries + 1);
                } catch (selectionError) {
                    throw error; // Throw original error if can't select new server
                }
            }

            throw error;
        }
    }

    /**
     * Get load balancer status
     * @returns {Object} - Load balancer status
     */
    getStatus() {
        return {
            strategy: 'least-connections-with-round-robin-fallback',
            roundRobinIndex: this.roundRobinIndex,
            maxRetries: CONFIG.MAX_RETRIES,
            requestTimeout: CONFIG.REQUEST_TIMEOUT
        };
    }
}

export default LoadBalancer;
