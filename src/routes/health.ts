import type { FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";
import { ensureCollection } from "../indexing/typesense-schema.js";

export function registerHealthRoutes(app: FastifyInstance, env: Env): void {
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await ensureCollection(app.typesense, env);
      await app.typesense.collections(env.SEARCH_INDEX_NAME).retrieve();
      return { status: "ready" };
    }
    catch { return reply.code(503).send({ status: "not_ready" }); }
  });
}
