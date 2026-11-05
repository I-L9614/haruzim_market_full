import mongoose from 'mongoose';
import { registerModelsOn } from './models.js';

// Per-request connection, per Cloudflare's documented restriction: I/O objects
// (sockets) created in one request cannot serve another request. The "direct
// connection" pattern costs ~300ms of handshake per request, which Cloudflare
// documents as acceptable for low-traffic use; a DO-pinned connection is the
// documented upgrade path if latency matters.
export async function connectDb(env) {
  if (!env.MONGO_URI) throw new Error('MONGO_URI must be configured before starting the API.');
  const connection = await mongoose.createConnection(env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 5
  }).asPromise();
  return { connection, models: registerModelsOn(connection) };
}

export function isValidObjectId(v) {
  return mongoose.isValidObjectId(v);
}

export async function startSession(connection) {
  return connection.startSession();
}

// Shared-connection mode (used only inside the API Durable Object, which has a
// 30s CPU budget per request, versus 10ms for a plain Worker on the Free plan).
// One MongoDB connection is reused across requests and closed after a short idle
// period so the object can go idle and stay inside the free duration allowance.
const IDLE_CLOSE_MS = 30000;
let sharedPromise = null;
let inflight = 0;
let idleTimer = null;

export async function acquireDb(env) {
  if (env.SHARED_DB !== '1') {
    const db = await connectDb(env);
    return { db, release: () => db.connection.close().catch(() => {}) };
  }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  inflight += 1;
  try {
    // Create the shared connection exactly once even when many requests arrive
    // together on a cold object; everyone awaits the same promise.
    const open = () => {
      const promise = connectDb(env);
      sharedPromise = promise;
      promise.catch(() => { if (sharedPromise === promise) sharedPromise = null; });
      return promise;
    };
    let db = await (sharedPromise || open());
    if (db.connection.readyState === 0 || db.connection.readyState === 3) {
      // connection dropped: replace it (only the first caller swaps it)
      if (sharedPromise && (await sharedPromise) === db) { db.connection.close().catch(() => {}); db = await open(); }
      else db = await sharedPromise;
    }
    let released = false;
    return {
      db,
      release: () => {
        if (released) return;
        released = true;
        inflight -= 1;
        if (inflight === 0 && !idleTimer) {
          idleTimer = setTimeout(() => {
            idleTimer = null;
            if (inflight > 0) return;
            const closing = sharedPromise;
            sharedPromise = null;
            closing?.then((d) => d.connection.close()).catch(() => {});
          }, IDLE_CLOSE_MS);
        }
      }
    };
  } catch (error) {
    inflight -= 1;
    sharedPromise = null;
    throw error;
  }
}
