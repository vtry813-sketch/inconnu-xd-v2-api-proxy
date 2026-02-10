import axios from 'axios';
import { CONFIG } from '../config/constants.js';
import { logger } from '../utils/logger.js';
import { delay } from '../utils/helpers.js';

/**
 * Health Monitor Service
 * Periodically checks backend server health
 */
class HealthMonitor {
    constructor(serverManager) {
        this.serverManager = serverManager;
        this.isMonitoring = false;
        this.healthCheckInterval = null;
    }

    /**
     * Start health monitoring
     */
    start() {
        if (this.isMonitoring) {
            logger.warn('Health monitor is already running');
            return;
        }

        this.isMonitoring = true;
        logger.info('Starting health monitor service');
        
        // Initial health check
        this.performHealthChecks();
        
        // Periodic health checks
        this.healthCheckInterval = setInterval(
            () => this.performHealthChecks(),
            CONFIG.HEALTH_CHECK_INTERVAL
        );
    }

    /**
     * Stop health monitoring
     */
    stop() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        this.isMonitoring = false;
        logger.info('Health monitor service stopped');
    }

    /**
     * Perform health checks on all servers
     */
    async performHealthChecks() {
        const servers = this.serverManager.getAllServers();
        logger.debug('Performing health checks on servers', { count: servers.length });
        
        const checkPromises = servers.map(server => 
            this.checkServerHealth(server)
        );
        
        await Promise.allSettled(checkPromises);
    }

    /**
     * Check individual server health
     * @param {Object} server - Server object
     */
    async checkServerHealth(server) {
        try {
            const response = await axios.get(`${server.url}/sessions`, {
                timeout: CONFIG.REQUEST_TIMEOUT
            });
            
            if (response.status === 200) {
                const sessions = response.data?.sessions || [];
                const sessionCount = sessions.length;
                
                // Update server status based on session count
                let newStatus = CONFIG.STATUS.HEALTHY;
                if (sessionCount >= CONFIG.MAX_SESSIONS_PER_SERVER) {
                    newStatus = CONFIG.STATUS.FULL;
                    logger.warn(`Server ${server.id} is full (${sessionCount}/${CONFIG.MAX_SESSIONS_PER_SERVER} sessions)`);
                }
                
                this.serverManager.updateServerStatus(server.id, newStatus, {
                    sessionCount,
                    lastChecked: new Date().toISOString(),
                    responseTime: response.duration || 0,
                    sessionsList: sessions // Store sessions for quick lookup
                });
                
                logger.debug(`Server ${server.id} health check passed`, {
                    status: newStatus,
                    sessions: sessionCount
                });
            } else {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (error) {
            logger.warn(`Health check failed for server ${server.id}:`, {
                error: error.message
            });
            
            this.serverManager.updateServerStatus(server.id, CONFIG.STATUS.UNHEALTHY, {
                error: error.message,
                lastChecked: new Date().toISOString()
            });
        }
    }

    /**
     * Manually trigger health check for a server
     * @param {string} serverId - Server ID
     */
    async checkServer(serverId) {
        const server = this.serverManager.getServer(serverId);
        if (!server) {
            throw new Error(`Server ${serverId} not found`);
        }
        
        await this.checkServerHealth(server);
        return this.serverManager.getServer(serverId);
    }

    /**
     * Get health monitor status
     */
    getStatus() {
        return {
            isMonitoring: this.isMonitoring,
            interval: CONFIG.HEALTH_CHECK_INTERVAL,
            lastCheck: new Date().toISOString()
        };
    }
}

export default HealthMonitor;
