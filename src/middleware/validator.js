import { validatePhoneNumber, validateSessionId } from '../utils/helpers.js';
import { createResponse } from '../utils/helpers.js';

/**
 * Validate phone number middleware
 */
export const validatePairRequest = (req, res, next) => {
    const { number } = req.params;
    
    if (!number) {
        return res.status(400).json(
            createResponse(false, null, 'Phone number is required')
        );
    }
    
    if (!validatePhoneNumber(number)) {
        return res.status(400).json(
            createResponse(false, null, 'Invalid phone number format. Must be 6-15 digits.')
        );
    }
    
    next();
};

/**
 * Validate session ID middleware
 */
export const validateSessionIdParam = (req, res, next) => {
    const { sessionId } = req.params;
    
    if (!sessionId) {
        return res.status(400).json(
            createResponse(false, null, 'Session ID is required')
        );
    }
    
    if (!validateSessionId(sessionId)) {
        return res.status(400).json(
            createResponse(false, null, 'Invalid session ID format')
        );
    }
    
    next();
};

/**
 * Validate server ID middleware
 */
export const validateServerId = (req, res, next) => {
    const { serverId } = req.params;
    
    if (!serverId) {
        return res.status(400).json(
            createResponse(false, null, 'Server ID is required')
        );
    }
    
    next();
};
