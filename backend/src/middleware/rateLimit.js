const buckets = new Map();

function createRateLimit({ windowMs, max, message = 'בוצעו יותר מדי ניסיונות. נסו שוב בעוד מספר דקות.' }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip || req.socket.remoteAddress || 'unknown'}:${req.baseUrl}${req.route?.path || req.path}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      return res.status(429).json({ success: false, error: message });
    }
    if (buckets.size > 10000) {
      for (const [bucketKey, value] of buckets) if (value.resetAt <= now) buckets.delete(bucketKey);
    }
    return next();
  };
}

module.exports = { createRateLimit };
