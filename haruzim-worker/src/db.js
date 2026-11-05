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
