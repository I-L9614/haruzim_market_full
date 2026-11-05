import { SignJWT, jwtVerify } from 'jose';

function key(env) {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) throw new Error('JWT secret is not configured');
  return new TextEncoder().encode(env.JWT_SECRET);
}

export async function signToken(payload, expiresIn, env) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key(env));
}

export async function verifyToken(token, env) {
  const { payload } = await jwtVerify(token, key(env));
  return payload;
}
