import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { hasWebhookSecret } from "../security/webhook-auth.js";
import { deleteEntity, upsertEntity } from "../indexing/upsert.js";
import type { IndexWebhookPayload } from "../types/search.js";

const payloadSchema = z.object({ type: z.enum(["INSERT", "UPDATE", "DELETE"]), table: z.enum(["places", "trip_boards", "fav_categories"]), schema: z.literal("public"), record: z.unknown().optional(), old_record: z.unknown().optional() });

export function registerInternalIndexRoute(app: FastifyInstance, env: Env): void {
  app.post("/internal/index", async (request, reply) => {
    if (!hasWebhookSecret(request, env)) return reply.code(401).send({ code: "UNAUTHORIZED" });
    const parsed = payloadSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ code: "INVALID_WEBHOOK", issues: parsed.error.issues });
    const payload = parsed.data as IndexWebhookPayload; const row = (payload.type === "DELETE" ? payload.old_record : payload.record);
    if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string") return reply.code(400).send({ code: "INVALID_RECORD" });
    const type = payload.table === "places" ? "place" : payload.table === "trip_boards" ? "board" : "collection";
    if (payload.type === "DELETE") await deleteEntity(app.typesense, env, type, row.id);
    else await upsertEntity(app.typesense, env, payload.table, row.id);
    return { accepted: true, operation: payload.type, table: payload.table, id: row.id };
  });
}
