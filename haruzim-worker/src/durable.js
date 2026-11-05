import { DurableObject } from 'cloudflare:workers';
import bcrypt from 'bcryptjs';

// bcrypt cost-12 runs here: Durable Objects have a 30s CPU budget per request,
// plain Workers are limited to 10ms (verified empirically: DO route 40/40 OK, plain route 503s).
let appHandler = null;
export function registerApp(handler) { appHandler = handler; }

export class AuthDO extends DurableObject {
  // The 'api-v1' instance serves all HTTP traffic (see index.js); the 'auth'
  // instance only runs bcrypt through RPC.
  async fetch(request) {
    if (!appHandler) return new Response('Service unavailable', { status: 503 });
    const ctx = {
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      passThroughOnException() {}
    };
    return appHandler(request, this.env, ctx);
  }

  async hashPassword(password) {
    return bcrypt.hash(password, 12);
  }
  async verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
  }
}

export class RealtimeDO extends DurableObject {
  // Live sockets come from ctx.getWebSockets(), never an in-memory Set:
  // after hibernation the DO instance resets (a Set would be empty) while
  // the accepted WebSocket connections stay open - broadcasts must still reach them.
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(event, payload) {
    const message = JSON.stringify({ event, payload });
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(message); delivered += 1; } catch { try { ws.close(); } catch { /* already closed */ } }
    }
    return { delivered };
  }
}

// Single-instance rate limiter: one hot DO keeps bucket state in memory across
// isolates, restoring the original single-process semantics that a per-isolate
// Map lost. Eviction after long idle can reset buckets - the original process
// restart had the same effect, and active abuse keeps the DO alive.
export class RateLimitDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.buckets = new Map();
  }

  async check(key, windowMs, max) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > 10000) {
      for (const [bucketKey, value] of this.buckets) if (value.resetAt <= now) this.buckets.delete(bucketKey);
    }
    return { count: bucket.count, resetAt: bucket.resetAt, allowed: bucket.count <= max, max };
  }
}
