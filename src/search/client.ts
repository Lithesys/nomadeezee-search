import Typesense from "typesense";
import type { Env } from "../config/env.js";
import { FULL_SEARCH_PARAMS, SUGGEST_PARAMS } from "./ranking.js";

export function createTypesense(env: Env) {
  return new Typesense.Client({ nodes: [{ host: env.TYPESENSE_HOST, port: env.TYPESENSE_PORT, protocol: env.TYPESENSE_PROTOCOL }], apiKey: env.TYPESENSE_API_KEY, connectionTimeoutSeconds: 5 });
}

export function collection(client: Typesense.Client, name: string) { return client.collections(name); }
export { FULL_SEARCH_PARAMS, SUGGEST_PARAMS };
