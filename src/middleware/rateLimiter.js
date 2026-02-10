import rateLimit from 'express-rate-limit';

/**
 * Rate limiting middleware
 */
export const apiLimiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // Limit each IP to 100 requests per windowMs
    message: {
        ok: false,
        error: 'Too many requests from this IP, please try again later.'
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

/**
 * Special rate limiter for pairing endpoint
 */
export const pairLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // Stricter limit for pairing
    message: {
        ok: false,
        error: 'Too many pairing requests. Please try again later.'
    }
});

/**
 * Rate limiter for session deletion
 */
export const deleteSessionLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute per IP
    message: {
        ok: false,
        error: 'Too many session deletion requests. Please try again later.'
    }
});
