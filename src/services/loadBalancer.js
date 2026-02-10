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
        const targetUrl = `${server.url}${originalUrl}`;
        
        logger.info('Forwarding request', {
            from: req.ip,
            to: server.id,
            url: targetUrl,
            retry: retries,
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
                    host: new URL(server.url).host
                },
                timeout: CONFIG.REQUEST_TIMEOUT,
                validateStatus: null // Don't throw on HTTP error status
            };

            if (body && Object.keys(body).length > 0) {
                config.data = body;
            }

            const response = await axios(config);
            
            logger.debug('Backend response', {
                server: server.id,
                status: response.status,
                duration: response.duration,
                sessionId: req.params.sessionId
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
                sessionId: req.params.sessionId
            });

            // Mark server as unhealthy on certain errors
            if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                this.serverManager.updateServerStatus(server.id, CONFIG.STATUS.UNHEALTHY, {
                    error: error.message
                });
            }

            // Retry logic
            if (retries < CONFIG.MAX_RETRIES) {
                await delay(CONFIG.RETRY_DELAY * (retries + 1));
                
                // Try to select a different server
                const newServer = await this.selectOptimalServer();
                return this.forwardRequest(req, newServer, retries + 1);
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
