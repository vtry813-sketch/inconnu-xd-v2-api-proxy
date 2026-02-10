import winston from 'winston';

/**
 * Professional logging configuration
 */
export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'smart-gateway' },
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    return `${timestamp} [${level}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
                })
            )
        })
    ]
});

/**
 * Log utility functions
 */
export const logRequest = (req, server = null) => {
    logger.info('API Request', {
        method: req.method,
        path: req.path,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        targetServer: server
    });
};

export const logError = (error, context = {}) => {
    logger.error(`Error: ${error.message}`, {
        ...context,
        stack: error.stack
    });
};
