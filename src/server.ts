import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type Typesense from "typesense";
import { loadEnv, type Env } from "./config/env.js";
import { createJwtVerifier, bearerToken, type AuthIdentity } from "./auth/supabase-auth.js";
import { createTypesense } from "./search/client.js";
import { ensureCollection } from "./indexing/typesense-schema.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerInternalIndexRoute } from "./routes/internal-index.js";
import { registerAdminRoutes } from "./routes/admin-rebuild.js";
import { startChangeLogWorker } from "./indexing/change-log.js";

declare module "fastify" {
  interface FastifyInstance { typesense: Typesense.Client; searchEnv: Env; }
  interface FastifyRequest { identity?: AuthIdentity; }
}

export async function buildServer(env: Env = loadEnv()): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: env.NODE_ENV === "production" ? "info" : "debug", redact: ["req.headers.authorization", "req.headers.x-search-webhook-secret", "req.headers.x-search-admin-secret"] } });
  const anonymousBuckets = new Map<string, { count: number; resetAt: number }>();
  const typesense = createTypesense(env); app.decorate("typesense", typesense); app.decorate("searchEnv", env);
  await app.register(cors, { origin: env.CORS_ORIGINS, methods: ["GET", "OPTIONS"] });
  await app.register(rateLimit, { max: env.SEARCH_AUTHENTICATED_RPM, timeWindow: "1 minute", keyGenerator: (request) => request.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || request.ip });
  const verify = createJwtVerifier(env);
  app.addHook("preHandler", async (request, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (!token) return;
    try { request.identity = await verify(token); } catch { return reply.code(401).send({ code: "INVALID_TOKEN" }); }
  });
  app.addHook("preHandler", async (request, reply) => {
    if (request.identity || !request.url.startsWith("/v1/")) return;
    const key = request.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || request.ip;
    const now = Date.now(); const bucket = anonymousBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) anonymousBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    else if (bucket.count >= env.SEARCH_PUBLIC_RPM) return reply.code(429).send({ code: "RATE_LIMITED" });
    else bucket.count += 1;
  });
  app.addHook("onResponse", async (request, reply) => { request.log.info({ route: request.routeOptions.url, status: reply.statusCode, durationMs: reply.elapsedTime }, "search request"); });
  void ensureCollection(typesense, env).catch((error) => app.log.warn({ error: error instanceof Error ? error.message : "Typesense unavailable" }, "Typesense collection initialization deferred"));
  registerHealthRoutes(app, env); await registerSearchRoutes(app, env); registerInternalIndexRoute(app, env); registerAdminRoutes(app, env);
  const stopChangeLog = startChangeLogWorker(typesense, env, app.log);
  if (stopChangeLog) app.addHook("onClose", async () => { await stopChangeLog(); });
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const env = loadEnv();
  buildServer(env).then((app) => app.listen({ port: env.PORT, host: "0.0.0.0" })).catch((error) => { console.error(error); process.exitCode = 1; });
}
