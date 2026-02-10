import { CONFIG } from '../config/constants.js';

/**
 * Utility helper functions
 */

/**
 * Validate phone number format
 * @param {string} number - Phone number to validate
 * @returns {boolean} - True if valid
 */
export const validatePhoneNumber = (number) => {
    const phoneRegex = /^[0-9]{6,15}$/;
    return phoneRegex.test(number);
};

/**
 * Validate session ID format
 * @param {string} sessionId - Session ID to validate
 * @returns {boolean} - True if valid
 */
export const validateSessionId = (sessionId) => {
    // Session IDs can be alphanumeric, may contain hyphens, underscores
    const sessionRegex = /^[a-zA-Z0-9_-]{10,100}$/;
    return sessionRegex.test(sessionId);
};

/**
 * Calculate server load percentage
 * @param {number} currentSessions - Current sessions count
 * @param {number} maxSessions - Maximum sessions allowed
 * @returns {number} - Load percentage
 */
export const calculateLoadPercentage = (currentSessions, maxSessions) => {
    return Math.round((currentSessions / maxSessions) * 100);
};

/**
 * Create standardized API response
 * @param {boolean} ok - Success status
 * @param {any} data - Response data
 * @param {string} error - Error message
 * @returns {Object} - Standardized response
 */
export const createResponse = (ok = true, data = null, error = null) => {
    return {
        ok,
        timestamp: new Date().toISOString(),
        ...(data && { data }),
        ...(error && { error })
    };
};

/**
 * Delay execution
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise} - Promise that resolves after delay
 */
export const delay = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Generate capacity recommendations based on current usage
 * @param {number} totalSessions - Total active sessions
 * @param {number} totalCapacity - Total capacity across all servers
 * @param {number} serverCount - Number of servers
 * @returns {Array} - List of recommendations
 */
export const generateCapacityRecommendations = (totalSessions, totalCapacity, serverCount) => {
    const recommendations = [];
    const usagePercentage = Math.round((totalSessions / totalCapacity) * 100);
    
    if (usagePercentage >= 90) {
        recommendations.push({
            level: 'CRITICAL',
            message: `Capacity nearly exhausted (${usagePercentage}%). Consider adding more backend servers.`,
            action: 'Scale horizontally by adding more backend instances'
        });
    } else if (usagePercentage >= 75) {
        recommendations.push({
            level: 'WARNING',
            message: `High capacity usage (${usagePercentage}%). Monitor closely.`,
            action: 'Prepare to scale by provisioning additional servers'
        });
    }
    
    if (serverCount === 1) {
        recommendations.push({
            level: 'INFO',
            message: 'Running with single backend server. No failover available.',
            action: 'Add at least one more backend server for high availability'
        });
    }
    
    const availableSessions = totalCapacity - totalSessions;
    if (availableSessions < CONFIG.MAX_SESSIONS_PER_SERVER) {
        recommendations.push({
            level: 'INFO',
            message: `Limited capacity available (${availableSessions} sessions).`,
            action: `Each server can handle ${CONFIG.MAX_SESSIONS_PER_SERVER} sessions`
        });
    }
    
    return recommendations;
};

/**
 * Calculate capacity metrics
 * @param {Array} servers - List of servers with session counts
 * @returns {Object} - Capacity metrics
 */
export const calculateCapacityMetrics = (servers) => {
    const totalSessions = servers.reduce((sum, server) => sum + (server.sessionCount || 0), 0);
    const totalCapacity = servers.length * CONFIG.MAX_SESSIONS_PER_SERVER;
    const usedPercentage = Math.round((totalSessions / totalCapacity) * 100);
    
    return {
        totalSessions,
        totalCapacity,
        availableSessions: totalCapacity - totalSessions,
        usedPercentage,
        averagePerServer: servers.length > 0 ? Math.round(totalSessions / servers.length) : 0,
        maxPerServer: CONFIG.MAX_SESSIONS_PER_SERVER
    };
};
