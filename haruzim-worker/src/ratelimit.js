// DO-backed limiter: state lives in one RateLimitDO instance so limits hold
// across all edge isolates, matching the original single-process Map semantics.
export function createRateLimit({ windowMs, max, message = 'בוצעו יותר מדי ניסיונות. נסו שוב בעוד מספר דקות.' }) {
  return async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') || 'unknown';
    const key = `${ip}:${c.req.path}`;
    const stub = c.env.RATE_LIMIT_DO.get(c.env.RATE_LIMIT_DO.idFromName('limiter'));
    const result = await stub.check(key, windowMs, max);
    c.header('RateLimit-Limit', String(result.max));
    c.header('RateLimit-Remaining', String(Math.max(0, result.max - result.count)));
    c.header('RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    if (!result.allowed) {
      return c.json({ success: false, error: message }, 429);
    }
    return next();
  };
}
