import { CONFIG } from '../config/constants.js';
import { createResponse, generateCapacityRecommendations } from '../utils/helpers.js';
import { logger, logRequest } from '../utils/logger.js';

/**
 * API Controller
 */
class ApiController {
    constructor(serverManager, loadBalancer, healthMonitor) {
        this.serverManager = serverManager;
        this.loadBalancer = loadBalancer;
        this.healthMonitor = healthMonitor;
    }

    /**
     * Handle pairing request
     */
    async handlePair(req, res) {
        try {
            const { number } = req.params;
            logRequest(req);
            
            logger.info('Processing pair request', { number });
            
            // Sélectionner le serveur backend optimal
            let selectedServer;
            try {
                selectedServer = await this.loadBalancer.selectOptimalServer();
                logger.info('Selected server for pairing', {
                    server: selectedServer.id,
                    serverUrl: selectedServer.url,
                    number
                });
            } catch (selectionError) {
                logger.error('Failed to select server:', {
                    error: selectionError.message,
                    number
                });
                
                let statusCode = 503;
                let errorMessage = 'Service unavailable';
                
                switch (selectionError.message) {
                    case 'ALL_FULL':
                        errorMessage = `All API servers are full (${CONFIG.MAX_SESSIONS_PER_SERVER}/${CONFIG.MAX_SESSIONS_PER_SERVER})`;
                        break;
                    case 'ALL_UNAVAILABLE':
                        errorMessage = 'All backend servers are unavailable';
                        break;
                    case 'NO_ACTIVE_SERVERS':
                        errorMessage = 'No active backend servers available';
                        break;
                }
                
                return res.status(statusCode).json(
                    createResponse(false, null, errorMessage)
                );
            }
            
            // Forward request to backend
            let backendResponse;
            try {
                backendResponse = await this.loadBalancer.forwardRequest(req, selectedServer);
                logger.debug('Backend response received', {
                    server: selectedServer.id,
                    status: backendResponse.status,
                    data: backendResponse.data
                });
                
                // Log détaillé de la réponse
                logger.info('Backend response structure', {
                    server: selectedServer.id,
                    hasOk: !!backendResponse.data?.ok,
                    dataKeys: Object.keys(backendResponse.data || {}),
                    fullData: backendResponse.data
                });
                
            } catch (forwardError) {
                logger.error('Failed to forward request to backend:', {
                    server: selectedServer.id,
                    error: forwardError.message,
                    code: forwardError.code,
                    number,
                    stack: forwardError.stack
                });
                
                return res.status(503).json(
                    createResponse(false, null, `Backend server unavailable: ${forwardError.message}`)
                );
            }
            
            // Check backend response
            if (!backendResponse.data) {
                logger.error('Backend returned empty response', {
                    server: selectedServer.id,
                    status: backendResponse.status
                });
                
                return res.status(502).json(
                    createResponse(false, null, 'Backend server returned empty response')
                );
            }
            
            // Vérifier si le backend a retourné une erreur
            if (backendResponse.data.error) {
                logger.error('Backend returned error:', {
                    server: selectedServer.id,
                    error: backendResponse.data.error,
                    status: backendResponse.status
                });
                
                return res.status(backendResponse.status >= 400 ? backendResponse.status : 400).json(
                    createResponse(false, null, backendResponse.data.error)
                );
            }
            
            // Update server session count if pairing successful
            if (backendResponse.data?.ok) {
                try {
                    const currentCount = await this.serverManager.getServerSessionCount(selectedServer.id);
                    
                    // Extract session ID from response - VOTRE BACKEND RETOURNE `sessionId` ou `cleanNumber`
                    const sessionId = backendResponse.data.sessionId || backendResponse.data.cleanNumber;
                    if (sessionId) {
                        // Update session mapping
                        this.serverManager.sessionMap.set(sessionId, selectedServer.id);
                    }
                    
                    logger.info('Pairing successful', {
                        server: selectedServer.id,
                        sessionId: sessionId,
                        code: backendResponse.data.code,
                        newSessionCount: currentCount + 1,
                        number
                    });
                } catch (updateError) {
                    logger.warn('Failed to update session count after pairing:', {
                        error: updateError.message,
                        server: selectedServer.id
                    });
                    // Continue anyway - don't fail the request
                }
            }
            
            // Return backend response as-is
            res.status(backendResponse.status).json(backendResponse.data);
            
        } catch (error) {
            logger.error('Unexpected error in pair request:', { 
                error: error.message,
                stack: error.stack,
                number: req.params.number 
            });
            
            // Never expose internal errors in production
            const errorMessage = process.env.NODE_ENV === 'production' 
                ? 'An unexpected error occurred during pairing'
                : error.message;
            
            res.status(500).json(
                createResponse(false, null, errorMessage)
            );
        }
    }

    /**
     * Delete a session (intelligent detection)
     */
    async deleteSession(req, res) {
        try {
            const { sessionId } = req.params;
            logRequest(req);
            
            logger.info('Processing delete session request', { sessionId });
            
            // Find which server contains this session
            const sessionInfo = await this.serverManager.findSessionServer(sessionId);
            
            if (!sessionInfo || !sessionInfo.found) {
                logger.warn(`Session ${sessionId} not found on any server`);
                return res.status(404).json(
                    createResponse(false, null, `Session ${sessionId} not found on any backend server`)
                );
            }
            
            const { server } = sessionInfo;
            
            logger.info(`Deleting session ${sessionId} from server ${server.id}`, {
                serverUrl: server.url,
                cached: sessionInfo.cached
            });
            
            // Delete session from the server
            const deleteResult = await this.serverManager.deleteSessionFromServer(
                server.id, 
                sessionId
            );
            
            // Log the deletion
            logger.info(`Session ${sessionId} deleted successfully`, {
                server: server.id,
                response: deleteResult.response,
                newSessionCount: deleteResult.newSessionCount
            });
            
            // Return success response
            res.json({
                ok: true,
                message: `Session ${sessionId} deleted successfully`,
                server: {
                    id: server.id,
                    url: server.url
                },
                sessionId: sessionId,
                deletedAt: new Date().toISOString(),
                newSessionCount: deleteResult.newSessionCount,
                details: deleteResult.response
            });
            
        } catch (error) {
            logger.error('Delete session failed:', { 
                error: error.message,
                sessionId: req.params.sessionId,
                stack: error.stack
            });
            
            let statusCode = 500;
            let errorMessage = 'Failed to delete session';
            
            // Handle specific errors
            if (error.response) {
                // Backend server responded with error
                statusCode = error.response.status;
                errorMessage = error.response.data?.error || error.message;
            } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                statusCode = 503;
                errorMessage = 'Backend server unavailable';
            }
            
            res.status(statusCode).json(
                createResponse(false, null, errorMessage)
            );
        }
    }

    /**
     * Get health status
     */
    async getHealth(req, res) {
        try {
            const servers = this.serverManager.getAllServers();
            const sessionMapInfo = this.serverManager.getSessionMapInfo();
            
            const healthChecks = servers.map(server => ({
                id: server.id,
                url: server.url,
                status: server.status,
                isActive: server.isActive,
                sessionCount: server.sessionCount,
                lastChecked: server.lastChecked,
                responseTime: server.responseTime,
                loadPercentage: Math.round((server.sessionCount / CONFIG.MAX_SESSIONS_PER_SERVER) * 100),
                mappedSessions: sessionMapInfo.sessionsPerServer[server.id] || 0
            }));
            
            const allHealthy = healthChecks.every(s => s.status === 'healthy');
            const allActive = healthChecks.some(s => s.isActive);
            
            res.json({
                ok: true,
                gateway: 'operational',
                timestamp: new Date().toISOString(),
                summary: {
                    totalServers: servers.length,
                    healthyServers: healthChecks.filter(s => s.status === 'healthy').length,
                    activeServers: healthChecks.filter(s => s.isActive).length,
                    allHealthy,
                    hasCapacity: allActive,
                    totalMappedSessions: sessionMapInfo.totalMappedSessions
                },
                servers: healthChecks,
                loadBalancer: this.loadBalancer.getStatus(),
                healthMonitor: this.healthMonitor.getStatus(),
                sessionMapping: sessionMapInfo
            });
            
        } catch (error) {
            logger.error('Health check failed:', { error: error.message });
            res.status(500).json(
                createResponse(false, null, 'Failed to retrieve health status')
            );
        }
    }

    /**
     * Get statistics
     */
    async getStats(req, res) {
        try {
            const stats = this.serverManager.getStats();
            const sessionMapInfo = this.serverManager.getSessionMapInfo();
            
            res.json({
                ok: true,
                timestamp: new Date().toISOString(),
                ...stats,
                sessionMapping: sessionMapInfo
            });
            
        } catch (error) {
            logger.error('Stats retrieval failed:', { error: error.message });
            res.status(500).json(
                createResponse(false, null, 'Failed to retrieve statistics')
            );
        }
    }

    /**
     * Get server list
     */
    async getServers(req, res) {
        try {
            const servers = this.serverManager.getAllServers();
            const sessionMapInfo = this.serverManager.getSessionMapInfo();
            
            res.json({
                ok: true,
                timestamp: new Date().toISOString(),
                servers: servers.map(server => ({
                    id: server.id,
                    url: server.url,
                    status: server.status,
                    isActive: server.isActive,
                    sessionCount: server.sessionCount,
                    maxSessions: CONFIG.MAX_SESSIONS_PER_SERVER,
                    lastChecked: server.lastChecked,
                    mappedSessions: sessionMapInfo.sessionsPerServer[server.id] || 0,
                    metadata: {
                        createdAt: server.metadata.createdAt,
                        healthChecks: server.metadata.healthChecks,
                        failures: server.metadata.failures,
                        deletedSessions: server.metadata.deletedSessions
                    }
                }))
            });
            
        } catch (error) {
            logger.error('Server list retrieval failed:', { error: error.message });
            res.status(500).json(
                createResponse(false, null, 'Failed to retrieve server list')
            );
        }
    }

    /**
     * Get total sessions across all backends
     */
    async getTotalSessions(req, res) {
        try {
            logRequest(req);
            logger.info('Fetching total sessions across all backends');
            
            const totalSessionsData = await this.serverManager.getTotalSessions();
            const servers = this.serverManager.getAllServers();
            const sessionMapInfo = this.serverManager.getSessionMapInfo();
            
            // Generate recommendations
            const recommendations = generateCapacityRecommendations(
                totalSessionsData.summary.totalSessions,
                totalSessionsData.summary.totalCapacity,
                servers.length
            );
            
            const response = {
                ok: true,
                timestamp: new Date().toISOString(),
                ...totalSessionsData,
                metadata: {
                    cache: '5 seconds TTL',
                    lastUpdated: new Date().toISOString(),
                    maxSessionsPerServer: CONFIG.MAX_SESSIONS_PER_SERVER,
                    requestId: req.id || Math.random().toString(36).substr(2, 9)
                },
                sessionMapping: {
                    totalMappedSessions: sessionMapInfo.totalMappedSessions,
                    sessionsPerServer: sessionMapInfo.sessionsPerServer
                },
                alerts: {
                    isCapacityCritical: totalSessionsData.status.isCapacityCritical,
                    isAnyServerFull: totalSessionsData.status.isAnyServerFull,
                    isAnyServerUnhealthy: totalSessionsData.status.isAnyServerUnhealthy,
                    allServersHealthy: totalSessionsData.status.allServersHealthy
                },
                recommendations
            };
            
            logger.info('Total sessions retrieved successfully', {
                totalSessions: totalSessionsData.summary.totalSessions,
                totalCapacity: totalSessionsData.summary.totalCapacity,
                utilization: `${totalSessionsData.summary.usedPercentage}%`
            });
            
            res.json(response);
            
        } catch (error) {
            logger.error('Total sessions retrieval failed:', { error: error.message });
            
            // Fallback to cached/stored data
            const servers = this.serverManager.getAllServers();
            const sessionMapInfo = this.serverManager.getSessionMapInfo();
            const totalSessions = servers.reduce((sum, server) => sum + server.sessionCount, 0);
            const totalCapacity = servers.length * CONFIG.MAX_SESSIONS_PER_SERVER;
            
            res.status(200).json({
                ok: true,
                timestamp: new Date().toISOString(),
                summary: {
                    totalSessions,
                    totalCapacity,
                    availableSessions: totalCapacity - totalSessions,
                    usedPercentage: Math.round((totalSessions / totalCapacity) * 100),
                    serverCount: servers.length,
                    note: 'Using cached data - real-time fetch failed'
                },
                servers: servers.map(server => ({
                    serverId: server.id,
                    sessionCount: server.sessionCount,
                    status: server.status,
                    isActive: server.isActive,
                    lastChecked: server.lastChecked
                })),
                sessionMapping: sessionMapInfo,
                alert: {
                    message: 'Real-time data fetch failed, showing cached information',
                    error: error.message
                }
            });
        }
    }

    /**
     * Find session location
     */
    async findSession(req, res) {
        try {
            const { sessionId } = req.params;
            logRequest(req);
            
            logger.info('Finding session location', { sessionId });
            
            const sessionInfo = await this.serverManager.findSessionServer(sessionId);
            
            if (!sessionInfo || !sessionInfo.found) {
                return res.status(404).json(
                    createResponse(false, null, `Session ${sessionId} not found on any backend server`)
                );
            }
            
            res.json({
                ok: true,
                sessionId: sessionId,
                found: true,
                server: {
                    id: sessionInfo.server.id,
                    url: sessionInfo.server.url,
                    status: sessionInfo.server.status
                },
                cached: sessionInfo.cached || false,
                lastChecked: new Date().toISOString()
            });
            
        } catch (error) {
            logger.error('Find session failed:', { 
                error: error.message,
                sessionId: req.params.sessionId 
            });
            
            res.status(500).json(
                createResponse(false, null, 'Failed to find session')
            );
        }
    }

    /**
     * Force health check on specific server
     */
    async forceHealthCheck(req, res) {
        try {
            const { serverId } = req.params;
            const server = await this.healthMonitor.checkServer(serverId);
            
            res.json({
                ok: true,
                message: `Health check performed on ${serverId}`,
                server: {
                    id: server.id,
                    status: server.status,
                    sessionCount: server.sessionCount,
                    lastChecked: server.lastChecked
                }
            });
            
        } catch (error) {
            logger.error('Force health check failed:', { 
                error: error.message,
                serverId: req.params.serverId 
            });
            
            res.status(404).json(
                createResponse(false, null, error.message)
            );
        }
    }

    /**
     * Reset server status
     */
    async resetServer(req, res) {
        try {
            const { serverId } = req.params;
            this.serverManager.resetServer(serverId);
            
            res.json({
                ok: true,
                message: `Server ${serverId} has been reset to healthy status`
            });
            
        } catch (error) {
            logger.error('Server reset failed:', { 
                error: error.message,
                serverId: req.params.serverId 
            });
            
            res.status(404).json(
                createResponse(false, null, `Server ${req.params.serverId} not found`)
            );
        }
    }
}

export default ApiController;
