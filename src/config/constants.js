/**
 * Configuration constants for the Smart Gateway
 */
export const CONFIG = {
    // Backend servers configuration
    BACKEND_SERVERS: process.env.BACKEND_SERVERS?.split(',') || [
        'https://new-production-0876.up.railway.app',
        'https://new-production-b381.up.railway.app'
    ],
    
    // Session management
    MAX_SESSIONS_PER_SERVER: parseInt(process.env.MAX_SESSIONS_PER_SERVER) || 25,
    
    // Timeouts and intervals
    REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT) || 5000,
    HEALTH_CHECK_INTERVAL: parseInt(process.env.HEALTH_CHECK_INTERVAL) || 10000,
    SESSION_CACHE_TTL: parseInt(process.env.SESSION_CACHE_TTL) || 5000,
    
    // Retry configuration
    MAX_RETRIES: parseInt(process.env.MAX_RETRIES) || 3,
    RETRY_DELAY: 1000,
    
    // Server status
    STATUS: {
        HEALTHY: 'healthy',
        UNHEALTHY: 'unhealthy',
        FULL: 'full'
    }
};
