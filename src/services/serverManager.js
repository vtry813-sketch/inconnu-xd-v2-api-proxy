import axios from 'axios';
import { CONFIG } from '../config/constants.js';
import { cache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';
import { calculateCapacityMetrics } from '../utils/helpers.js';

/**
 * Server Manager Service
 * Manages backend server instances and their status
 */
class ServerManager {
    constructor() {
        this.servers = new Map();
        this.currentIndex = 0;
        this.sessionMap = new Map(); // sessionId -> serverId mapping
        this.initializeServers();
    }

    /**
     * Initialize servers from configuration
     */
    initializeServers() {
        CONFIG.BACKEND_SERVERS.forEach((url, index) => {
            const serverId = `server-${index + 1}`;
            this.servers.set(serverId, {
                id: serverId,
                url,
                status: CONFIG.STATUS.HEALTHY,
                sessionCount: 0,
                lastChecked: null,
                responseTime: 0,
                isActive: true,
                sessions: [], // Store session IDs for quick lookup
                metadata: {
                    createdAt: new Date().toISOString(),
                    healthChecks: 0,
                    failures: 0,
                    deletedSessions: 0
                }
            });
        });
        
        logger.info(`Initialized ${this.servers.size} backend servers`);
    }

    /**
     * Get all servers
     * @returns {Array} - List of servers
     */
    getAllServers() {
        return Array.from(this.servers.values());
    }

    /**
     * Get active servers (healthy and not full)
     * @returns {Array} - List of active servers
     */
    getActiveServers() {
        return this.getAllServers().filter(server => 
            server.status === CONFIG.STATUS.HEALTHY && 
            server.isActive
        );
    }

    /**
     * Get server by ID
     * @param {string} serverId - Server ID
     * @returns {Object|null} - Server object or null
     */
    getServer(serverId) {
        return this.servers.get(serverId) || null;
    }

    /**
     * Find which backend server contains a specific session
     * @param {string} sessionId - Session ID to find
     * @returns {Promise<Object|null>} - Server containing the session, or null
     */
    async findSessionServer(sessionId) {
        // First check cache
        const cachedServerId = this.sessionMap.get(sessionId);
        if (cachedServerId) {
            const server = this.getServer(cachedServerId);
            if (server) {
                logger.debug(`Session ${sessionId} found in cache on server ${server.id}`);
                return {
                    server: server,
                    cached: true,
                    found: true
                };
            }
        }
        
        // Search across all servers
        const servers = this.getAllServers();
        
        for (const server of servers) {
            try {
                // Check if server has session in memory
                if (server.sessions && server.sessions.includes(sessionId)) {
                    logger.debug(`Session ${sessionId} found in memory on server ${server.id}`);
                    this.sessionMap.set(sessionId, server.id);
                    return {
                        server: server,
                        cached: true,
                        found: true
                    };
                }
                
                // Get sessions from the server API
                const response = await axios.get(`${server.url}/sessions`, {
                    timeout: CONFIG.REQUEST_TIMEOUT
                });
                
                const sessions = response.data?.sessions || [];
                
                // Update server sessions in memory
                server.sessions = sessions.map(s => s.id || s.sessionId);
                
                // Check if session exists on this server
                const sessionExists = sessions.some(session => 
                    session.id === sessionId || 
                    session.sessionId === sessionId
                );
                
                if (sessionExists) {
                    logger.info(`Session ${sessionId} found on server ${server.id}`);
                    this.sessionMap.set(sessionId, server.id);
                    return {
                        server: server,
                        cached: false,
                        found: true,
                        sessionDetails: sessions.find(s => 
                            s.id === sessionId || s.sessionId === sessionId
                        )
                    };
                }
            } catch (error) {
                logger.warn(`Failed to check sessions on server ${server.id}:`, {
                    error: error.message,
                    sessionId
                });
                continue;
            }
        }
        
        logger.warn(`Session ${sessionId} not found on any server`);
        return null;
    }

    /**
     * Delete a session from a specific server
     * @param {string} serverId - Server ID
     * @param {string} sessionId - Session ID to delete
     * @returns {Promise<Object>} - Delete operation result
     */
    async deleteSessionFromServer(serverId, sessionId) {
        const server = this.getServer(serverId);
        if (!server) {
            throw new Error(`Server ${serverId} not found`);
        }
        
        try {
            // Make DELETE request to backend's logout endpoint
            const response = await axios.post(
                `${server.url}/logout/${sessionId}`,
                {},
                {
                    timeout: CONFIG.REQUEST_TIMEOUT,
                    headers: {
                        'x-proxy-action': 'delete-session',
                        'x-proxy-server-id': serverId,
                        'x-proxy-timestamp': new Date().toISOString()
                    }
                }
            );
            
            // Update metadata
            server.metadata.deletedSessions++;
            
            // Remove from session map
            this.sessionMap.delete(sessionId);
            
            // Remove from server sessions list
            if (server.sessions) {
                server.sessions = server.sessions.filter(s => s !== sessionId);
            }
            
            // Update session count
            if (server.sessionCount > 0) {
                server.sessionCount--;
            }
            
            // Clear session cache for this server
            cache.delete(`sessions_${serverId}`);
            
            logger.info(`Session ${sessionId} deleted from server ${server.id}`, {
                response: response.data,
                newSessionCount: server.sessionCount
            });
            
            return {
                success: true,
                serverId: server.id,
                sessionId: sessionId,
                response: response.data,
                newSessionCount: server.sessionCount
            };
            
        } catch (error) {
            logger.error(`Failed to delete session ${sessionId} from server ${server.id}:`, {
                error: error.message,
                response: error.response?.data
            });
            
            // If session not found on backend, still clean up local mapping
            if (error.response?.status === 404) {
                this.sessionMap.delete(sessionId);
                if (server.sessions) {
                    server.sessions = server.sessions.filter(s => s !== sessionId);
                }
            }
            
            throw error;
        }
    }

    /**
     * Update server status
     * @param {string} serverId - Server ID
     * @param {string} status - New status
     * @param {Object} data - Additional data
     */
    updateServerStatus(serverId, status, data = {}) {
        const server = this.servers.get(serverId);
        if (!server) return;

        server.status = status;
        server.lastChecked = new Date().toISOString();
        server.metadata.healthChecks++;
        
        if (status === CONFIG.STATUS.UNHEALTHY) {
            server.metadata.failures++;
            server.isActive = false;
            logger.error(`Server ${serverId} marked as unhealthy`);
        } else if (status === CONFIG.STATUS.FULL) {
            server.isActive = false;
            logger.warn(`Server ${serverId} marked as full`);
        } else {
            server.isActive = true;
        }

        // Update additional data
        Object.assign(server, data);
        
        // Clear cache for this server's sessions
        cache.delete(`sessions_${serverId}`);
    }

    /**
     * Get real-time session count from server
     * @param {string} serverId - Server ID
     * @returns {Promise<number>} - Session count
     */
    async getServerSessionCount(serverId) {
        const cacheKey = `sessions_${serverId}`;
        const cached = cache.get(cacheKey);
        
        if (cached !== null) {
            return cached;
        }
        
        const server = this.getServer(serverId);
        if (!server) {
            throw new Error(`Server ${serverId} not found`);
        }
        
        try {
            const response = await axios.get(`${server.url}/sessions`, {
                timeout: CONFIG.REQUEST_TIMEOUT
            });
            
            const sessions = response.data?.sessions || [];
            const sessionCount = sessions.length;
            
            // Update sessions list in memory
            server.sessions = sessions.map(s => s.id || s.sessionId);
            
            // Update session map
            sessions.forEach(session => {
                const sessionId = session.id || session.sessionId;
                if (sessionId) {
                    this.sessionMap.set(sessionId, serverId);
                }
            });
            
            // Cache the result
            cache.set(cacheKey, sessionCount, CONFIG.SESSION_CACHE_TTL);
            
            // Update server data
            this.updateServerStatus(serverId, server.status, {
                sessionCount,
                responseTime: response.duration || 0
            });
            
            return sessionCount;
        } catch (error) {
            logger.error(`Failed to get sessions from ${serverId}:`, {
                error: error.message
            });
            
            // Mark as unhealthy if request fails
            if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                this.updateServerStatus(serverId, CONFIG.STATUS.UNHEALTHY, {
                    error: error.message
                });
            }
            
            throw error;
        }
    }

    /**
     * Get total sessions across all backends
     * @returns {Promise<Object>} - Total sessions information
     */
    async getTotalSessions() {
        const servers = this.getAllServers();
        
        // Get fresh session counts for all servers
        const sessionPromises = servers.map(async (server) => {
            try {
                const sessionCount = await this.getServerSessionCount(server.id);
                return {
                    serverId: server.id,
                    url: server.url,
                    sessionCount,
                    status: server.status,
                    isActive: server.isActive,
                    lastChecked: server.lastChecked,
                    maxSessions: CONFIG.MAX_SESSIONS_PER_SERVER,
                    loadPercentage: Math.round((sessionCount / CONFIG.MAX_SESSIONS_PER_SERVER) * 100)
                };
            } catch (error) {
                logger.warn(`Failed to get sessions for ${server.id}:`, {
                    error: error.message
                });
                return {
                    serverId: server.id,
                    url: server.url,
                    sessionCount: server.sessionCount || 0,
                    status: server.status,
                    isActive: false,
                    error: 'Failed to fetch real-time data',
                    maxSessions: CONFIG.MAX_SESSIONS_PER_SERVER,
                    loadPercentage: 0
                };
            }
        });
        
        const serverSessions = await Promise.all(sessionPromises);
        
        // Calculate capacity metrics
        const capacityMetrics = calculateCapacityMetrics(serverSessions);
        
        // Categorize servers
        const healthyServers = serverSessions.filter(s => s.status === 'healthy');
        const unhealthyServers = serverSessions.filter(s => s.status === 'unhealthy');
        const fullServers = serverSessions.filter(s => s.sessionCount >= CONFIG.MAX_SESSIONS_PER_SERVER);
        
        return {
            summary: {
                totalSessions: capacityMetrics.totalSessions,
                totalCapacity: capacityMetrics.totalCapacity,
                availableSessions: capacityMetrics.availableSessions,
                usedPercentage: capacityMetrics.usedPercentage,
                serverCount: servers.length,
                healthyCount: healthyServers.length,
                unhealthyCount: unhealthyServers.length,
                fullCount: fullServers.length,
                averageSessionsPerServer: capacityMetrics.averagePerServer
            },
            servers: serverSessions,
            capacity: {
                used: capacityMetrics.totalSessions,
                total: capacityMetrics.totalCapacity,
                available: capacityMetrics.availableSessions,
                utilization: capacityMetrics.usedPercentage,
                maxPerServer: CONFIG.MAX_SESSIONS_PER_SERVER
            },
            status: {
                isCapacityCritical: capacityMetrics.usedPercentage >= 90,
                isAnyServerFull: fullServers.length > 0,
                isAnyServerUnhealthy: unhealthyServers.length > 0,
                allServersHealthy: unhealthyServers.length === 0
            }
        };
    }

    /**
     * Get server statistics
     * @returns {Object} - Server statistics
     */
    getStats() {
        const allServers = this.getAllServers();
        const activeServers = this.getActiveServers();
        
        return {
            totalServers: allServers.length,
            activeServers: activeServers.length,
            unhealthyServers: allServers.filter(s => s.status === CONFIG.STATUS.UNHEALTHY).length,
            fullServers: allServers.filter(s => s.status === CONFIG.STATUS.FULL).length,
            totalSessions: allServers.reduce((sum, server) => sum + server.sessionCount, 0),
            sessionMapSize: this.sessionMap.size,
            servers: allServers.map(server => ({
                id: server.id,
                url: server.url,
                status: server.status,
                sessionCount: server.sessionCount,
                isActive: server.isActive,
                lastChecked: server.lastChecked,
                responseTime: server.responseTime,
                loadPercentage: Math.round((server.sessionCount / CONFIG.MAX_SESSIONS_PER_SERVER) * 100),
                metadata: {
                    healthChecks: server.metadata.healthChecks,
                    failures: server.metadata.failures,
                    deletedSessions: server.metadata.deletedSessions
                }
            }))
        };
    }

    /**
     * Reset server (mark as healthy)
     * @param {string} serverId - Server ID
     */
    resetServer(serverId) {
        const server = this.getServer(serverId);
        if (server) {
            server.status = CONFIG.STATUS.HEALTHY;
            server.isActive = true;
            logger.info(`Server ${serverId} reset to healthy`);
        }
    }

    /**
     * Get session mapping information
     * @returns {Object} - Session mapping stats
     */
    getSessionMapInfo() {
        const sessionCounts = {};
        this.servers.forEach((server, serverId) => {
            const sessionIds = Array.from(this.sessionMap.entries())
                .filter(([_, sId]) => sId === serverId)
                .map(([sessionId]) => sessionId);
            sessionCounts[serverId] = sessionIds.length;
        });
        
        return {
            totalMappedSessions: this.sessionMap.size,
            sessionsPerServer: sessionCounts,
            serverCount: this.servers.size
        };
    }
}

export default ServerManager;
