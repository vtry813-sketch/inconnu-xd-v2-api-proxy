import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';

// Configuration
dotenv.config();

// Import modules
import { logger } from './utils/logger.js';
import { apiLimiter, pairLimiter, deleteSessionLimiter } from './middleware/rateLimiter.js';
import { validatePairRequest, validateSessionIdParam, validateServerId } from './middleware/validator.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

// Import services
import ServerManager from './services/serverManager.js';
import LoadBalancer from './services/loadBalancer.js';
import HealthMonitor from './services/healthMonitor.js';
import ApiController from './controllers/apiController.js';

// Initialize application
const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now();
    
    // Generate request ID
    req.id = Math.random().toString(36).substr(2, 9);
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info('HTTP Request', {
            requestId: req.id,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration: `${duration}ms`,
            ip: req.ip,
            userAgent: req.get('user-agent')
        });
    });
    
    next();
});

// Initialize services
const serverManager = new ServerManager();
const loadBalancer = new LoadBalancer(serverManager);
const healthMonitor = new HealthMonitor(serverManager);
const apiController = new ApiController(serverManager, loadBalancer, healthMonitor);

// Start health monitoring
healthMonitor.start();

// Global rate limiting
app.use('/api/', apiLimiter);

// API Routes
app.get('/pair/:number', 
    pairLimiter, 
    validatePairRequest, 
    (req, res) => apiController.handlePair(req, res)
);

app.delete('/delete-session/:sessionId',
    deleteSessionLimiter,
    validateSessionIdParam,
    (req, res) => apiController.deleteSession(req, res)
);

app.get('/find-session/:sessionId',
    validateSessionIdParam,
    (req, res) => apiController.findSession(req, res)
);

app.get('/health', (req, res) => apiController.getHealth(req, res));
app.get('/stats', (req, res) => apiController.getStats(req, res));
app.get('/servers', (req, res) => apiController.getServers(req, res));
app.get('/total-sessions', (req, res) => apiController.getTotalSessions(req, res));

// Admin endpoints (could be protected with authentication in production)
app.post('/health/check/:serverId', 
    validateServerId,
    (req, res) => apiController.forceHealthCheck(req, res)
);

app.post('/servers/reset/:serverId',
    validateServerId,
    (req, res) => apiController.resetServer(req, res)
);

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        ok: true,
        service: 'Smart Gateway Proxy',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        endpoints: {
            pairing: 'GET /pair/:number',
            sessionManagement: {
                deleteSession: 'DELETE /delete-session/:sessionId',
                findSession: 'GET /find-session/:sessionId'
            },
            monitoring: {
                health: 'GET /health',
                stats: 'GET /stats',
                servers: 'GET /servers',
                totalSessions: 'GET /total-sessions'
            },
            admin: {
                healthCheck: 'POST /health/check/:serverId',
                resetServer: 'POST /servers/reset/:serverId'
            }
        },
        description: 'Smart Gateway for WhatsApp Multi-Session Backends with Intelligent Load Balancing and Session Management'
    });
});

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Graceful shutdown
const shutdown = async () => {
    logger.info('Shutting down gracefully...');
    
    // Stop health monitoring
    healthMonitor.stop();
    
    // Close server
    server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
    });
    
    // Force shutdown after 10 seconds
    setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
};

// Start server
const server = app.listen(PORT, () => {
    logger.info(`Smart Gateway Proxy is running on port ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`Backend servers: ${serverManager.getAllServers().length}`);
    logger.info(`Max sessions per server: ${process.env.MAX_SESSIONS_PER_SERVER || 25}`);
    logger.info('Available endpoints:');
    logger.info('  GET    /pair/:number');
    logger.info('  DELETE /delete-session/:sessionId');
    logger.info('  GET    /find-session/:sessionId');
    logger.info('  GET    /health');
    logger.info('  GET    /stats');
    logger.info('  GET    /servers');
    logger.info('  GET    /total-sessions');
});

// Handle process signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle unhandled errors
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', { promise, reason });
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', { error: error.message, stack: error.stack });
    process.exit(1);
});

export { app, serverManager, loadBalancer, healthMonitor };
