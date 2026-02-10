import { logger } from '../utils/logger.js';
import { createResponse } from '../utils/helpers.js';

/**
 * Global error handling middleware
 */
export const errorHandler = (err, req, res, next) => {
    logger.error('Unhandled error:', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method
    });
    
    // Default error response
    const statusCode = err.statusCode || 500;
    const message = err.message || 'Internal server error';
    
    // Never expose internal errors in production
    const errorMessage = process.env.NODE_ENV === 'production' 
        ? 'An unexpected error occurred' 
        : message;
    
    res.status(statusCode).json(
        createResponse(false, null, errorMessage)
    );
};

/**
 * 404 Not Found handler
 */
export const notFoundHandler = (req, res) => {
    res.status(404).json(
        createResponse(false, null, `Route ${req.originalUrl} not found`)
    );
};
