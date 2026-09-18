import type { FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";

export function registerHealthRoutes(app: FastifyInstance, env: Env): void {
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    try { await app.typesense.collections(env.SEARCH_INDEX_NAME).retrieve(); return { status: "ready" }; }
    catch { return reply.code(503).send({ status: "not_ready" }); }
  });
}
