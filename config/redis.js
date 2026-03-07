// config/redis.js
// Requires env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

const { Redis } = require('@upstash/redis');

let redis;

try {
    redis = new Redis({
        url:   process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('✅ Redis (Upstash) configured');
} catch (err) {
    console.error('❌ Redis config failed:', err.message);
    // Return a no-op stub so the rest of the server still works
    // without Redis (notifications will just be disabled)
    redis = {
        lpush: async () => null,
        ltrim: async () => null,
        lrange: async () => [],
        rpush: async () => null,
        del:   async () => null,
    };
}

module.exports = redis;
