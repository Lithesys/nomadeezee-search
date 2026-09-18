import type { FastifyRequest } from "fastify";
import type { Env } from "../config/env.js";
import { equalSecret } from "./secrets.js";

export function hasWebhookSecret(request: FastifyRequest, env: Env): boolean { return equalSecret(request.headers["x-search-webhook-secret"] as string | undefined, env.SEARCH_WEBHOOK_SECRET); }
export function hasAdminSecret(request: FastifyRequest, env: Env): boolean { return equalSecret(request.headers["x-search-admin-secret"] as string | undefined, env.SEARCH_ADMIN_SECRET); }
