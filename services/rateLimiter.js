/**
 * Lightweight, zero-dependency token-bucket rate limiter
 * Protects auth, campaign dispatch, and SMTP verification endpoints from abuse.
 */
class RateLimiter {
  constructor() {
    this.buckets = new Map();
    // Periodically clean up stale buckets every 5 minutes
    setInterval(() => this.cleanup(), 300000).unref();
  }

  cleanup() {
    const now = Date.now();
    for (const [key, record] of this.buckets.entries()) {
      if (now - record.lastReset > 600000) {
        this.buckets.delete(key);
      }
    }
  }

  createMiddleware({ windowMs = 60000, max = 30, message = 'Too many requests, please try again later.' }) {
    return (req, res, next) => {
      // Determine client IP
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ||
                 req.socket.remoteAddress ||
                 '127.0.0.1';

      const key = `${req.baseUrl || req.path}:${ip}`;
      const now = Date.now();

      let record = this.buckets.get(key);
      if (!record || (now - record.lastReset) >= windowMs) {
        record = { count: 1, lastReset: now };
        this.buckets.set(key, record);
      } else {
        record.count++;
      }

      const remaining = Math.max(0, max - record.count);
      const resetTime = Math.ceil((record.lastReset + windowMs - now) / 1000);

      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', resetTime);

      if (record.count > max) {
        return res.status(429).json({
          success: false,
          error: message,
          retryAfterSeconds: resetTime
        });
      }

      next();
    };
  }
}

module.exports = new RateLimiter();
