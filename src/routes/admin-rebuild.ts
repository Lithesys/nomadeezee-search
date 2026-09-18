import type { FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";
import { getRebuildJob, startRebuild } from "../indexing/rebuild.js";
import { hasAdminSecret } from "../security/webhook-auth.js";

export function registerAdminRoutes(app: FastifyInstance, env: Env): void {
  app.post("/admin/rebuild-index", async (request, reply) => { if (!hasAdminSecret(request, env)) return reply.code(401).send({ code: "UNAUTHORIZED" }); try { const job = startRebuild(app.typesense, env); return reply.code(202).send(job); } catch (error) { return reply.code(409).send({ code: "REBUILD_RUNNING", message: error instanceof Error ? error.message : "Rebuild already running" }); } });
  app.get<{ Params: { jobId: string } }>("/admin/rebuild-index/:jobId", async (request, reply) => { if (!hasAdminSecret(request, env)) return reply.code(401).send({ code: "UNAUTHORIZED" }); const job = getRebuildJob(request.params.jobId); return job ? job : reply.code(404).send({ code: "NOT_FOUND" }); });
}
