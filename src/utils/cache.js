/**
 * Simple in-memory cache with TTL support
 */
class Cache {
    constructor() {
        this.store = new Map();
        this.defaultTTL = 5000; // 5 seconds
    }

    /**
     * Set cache value with TTL
     * @param {string} key - Cache key
     * @param {any} value - Value to cache
     * @param {number} ttl - Time to live in milliseconds
     */
    set(key, value, ttl = this.defaultTTL) {
        const expiry = Date.now() + ttl;
        this.store.set(key, { value, expiry });
    }

    /**
     * Get cache value if not expired
     * @param {string} key - Cache key
     * @returns {any|null} - Cached value or null
     */
    get(key) {
        const item = this.store.get(key);
        
        if (!item) return null;
        
        if (Date.now() > item.expiry) {
            this.store.delete(key);
            return null;
        }
        
        return item.value;
    }

    /**
     * Delete cache entry
     * @param {string} key - Cache key
     */
    delete(key) {
        this.store.delete(key);
    }

    /**
     * Clear all cache
     */
    clear() {
        this.store.clear();
    }

    /**
     * Clean expired entries
     */
    cleanup() {
        const now = Date.now();
        for (const [key, item] of this.store.entries()) {
            if (now > item.expiry) {
                this.store.delete(key);
            }
        }
    }
}

export const cache = new Cache();
