// Per-account login lockout: consecutive failed sign-in attempts against one
// account key (scope + normalized email) are counted in MongoDB. At
// MAX_FAILURES the account is blocked for LOCK_MS and every further attempt -
// even with the correct password - is refused until the block expires. A
// successful sign-in clears the record, so successful logins are never counted
// and other accounts are never affected. State lives in Mongo (not the
// in-memory rate-limit DO) so a block survives isolate eviction and deploys.
export const MAX_FAILURES = 5;
export const LOCK_MS = 60 * 60 * 1000;

export function lockKey(scope, email) {
  return `${scope}:${email}`;
}

export async function activeLock(LoginThrottle, scope, email) {
  const doc = await LoginThrottle.findById(lockKey(scope, email)).select('lockedUntil').lean();
  if (doc?.lockedUntil && new Date(doc.lockedUntil).getTime() > Date.now()) return new Date(doc.lockedUntil);
  return null;
}

export async function recordFailure(LoginThrottle, scope, email) {
  const doc = await LoginThrottle.findOneAndUpdate(
    { _id: lockKey(scope, email) },
    { $inc: { failures: 1 }, $setOnInsert: { lockedUntil: null } },
    { upsert: true, returnDocument: 'after' }
  );
  if (doc.failures >= MAX_FAILURES) {
    const lockedUntil = new Date(Date.now() + LOCK_MS);
    // Counter restarts after the block expires.
    await LoginThrottle.updateOne({ _id: doc._id }, { $set: { lockedUntil, failures: 0 } });
    return { locked: true, lockedUntil };
  }
  return { locked: false, lockedUntil: null };
}

export async function clearFailures(LoginThrottle, scope, email) {
  await LoginThrottle.deleteOne({ _id: lockKey(scope, email) });
}

export function lockMessage(lockedUntil) {
  const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 60000));
  return `החשבון נחסם זמנית בעקבות ניסיונות התחברות כושלים. נסו שוב בעוד ${minutes} דקות.`;
}

export function lockedResponse(c, lockedUntil) {
  c.header('Retry-After', String(Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000))));
  return c.json({ error: 'ACCOUNT_LOCKED', message: lockMessage(lockedUntil) }, 429);
}
