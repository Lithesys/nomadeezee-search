# Nomadeezee Search

Standalone Fastify + Typesense search service for places, trip boards, and favourite collections. Supabase owns data and authorization; Typesense is disposable derived data.

## Local run

Copy `.env.example` to `.env`, set the Supabase URL and publishable key, then run:

```cmd
npm.cmd install
npm.cmd run build
docker compose up --build
```

The API listens on `http://localhost:10000`. `GET /health` is liveness; `GET /ready` checks Typesense. `POST /internal/index` requires `X-Search-Webhook-Secret`; rebuild endpoints require `X-Search-Admin-Secret`.

The indexing service uses the service role only for server-side reads and must never be bundled into browser code. Search responses are rechecked through Supabase RLS before normalized results are returned.

## Render

Deploy the API as `search-api` and Typesense as a private service with a persistent `/data` disk. Use the API’s private Typesense hostname and Render secrets. Keep one Typesense instance while a persistent disk is attached; Render documents that attached disks are single-instance and prevent zero-downtime replacement.
