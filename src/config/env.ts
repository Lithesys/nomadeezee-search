import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(10000),
  SUPABASE_URL: z.url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_JWT_AUDIENCE: z.string().default("authenticated"),
  SUPABASE_JWT_SECRET: z.string().min(16).optional(),
  TYPESENSE_HOST: z.string().min(1),
  TYPESENSE_PORT: z.coerce.number().int().min(1).default(8108),
  TYPESENSE_PROTOCOL: z.enum(["http", "https"]).default("http"),
  TYPESENSE_API_KEY: z.string().min(1),
  SEARCH_WEBHOOK_SECRET: z.string().min(16),
  SEARCH_ADMIN_SECRET: z.string().min(16),
  SEARCH_CURSOR_SECRET: z.string().min(16),
  SEARCH_CORS_ORIGINS: z.string().default("https://www.nomadeezee.com"),
  SEARCH_INDEX_NAME: z.string().default("search_documents"),
  SEARCH_PUBLIC_RPM: z.coerce.number().int().positive().default(60),
  SEARCH_AUTHENTICATED_RPM: z.coerce.number().int().positive().default(120),
  SEARCH_DATABASE_URL: z.string().optional(),
});

export type Env = z.infer<typeof schema> & { CORS_ORIGINS: string[] };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.parse(source);
  return { ...parsed, CORS_ORIGINS: parsed.SEARCH_CORS_ORIGINS.split(",").map((v) => v.trim()).filter(Boolean) };
}
