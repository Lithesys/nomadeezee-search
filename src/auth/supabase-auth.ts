import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "../config/env.js";

export interface AuthIdentity { userId: string; token: string; }

export function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice(7).trim();
  return token || undefined;
}

export function createJwtVerifier(env: Env) {
  const issuer = `${env.SUPABASE_URL}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return async (token: string): Promise<AuthIdentity> => {
    let payload: JWTPayload;
    if (env.SUPABASE_JWT_SECRET) {
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(env.SUPABASE_JWT_SECRET), { issuer, audience: env.SUPABASE_JWT_AUDIENCE }));
    } else {
      ({ payload } = await jwtVerify(token, jwks, { issuer, audience: env.SUPABASE_JWT_AUDIENCE }));
    }
    if (payload.role !== "authenticated" || typeof payload.sub !== "string") throw new Error("Invalid Supabase identity");
    return { userId: payload.sub, token };
  };
}
