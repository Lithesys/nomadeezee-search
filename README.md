# Nomadeezee Search

Standalone Fastify + Typesense search service for Nomadeezee places, trip
boards, and favourite collections. Supabase remains the source of truth for
data and authorization; Typesense is a disposable, derived read index.

## How it works

```text
Supabase tables
    ├─ database change log ──> search-api ──> Typesense
    └─ authenticated reads ──> search-api ──> filtered results
                                      ↑
                         public search / webhook / admin API
```

The API applies access filters before querying Typesense and re-checks returned
IDs through Supabase RLS before returning results. The service-role key is used
only by server-side indexing and rebuild code; it must never be exposed to a
browser.

## Requirements

- Node.js 22 or later
- Docker Desktop for the local API + Typesense stack
- A Supabase project with the search index change-log migration installed
- A Typesense server for local or hosted use

## Configuration

Copy the example file and replace every placeholder with a real value:

```cmd
copy .env.example .env
```

Required settings:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Key used for authenticated Supabase reads |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional server-only key for indexing reads |
| `SUPABASE_JWT_SECRET` | JWT verification secret when token verification is enabled |
| `TYPESENSE_HOST`, `TYPESENSE_PORT`, `TYPESENSE_PROTOCOL` | Typesense connection |
| `TYPESENSE_API_KEY` | Typesense API key |
| `SEARCH_WEBHOOK_SECRET` | Secret for `POST /internal/index` |
| `SEARCH_ADMIN_SECRET` | Secret for rebuild endpoints |
| `SEARCH_CURSOR_SECRET` | HMAC secret for pagination cursors |
| `SEARCH_CORS_ORIGINS` | Comma-separated allowed browser origins |
| `SEARCH_INDEX_NAME` | Typesense alias used by the API |
| `SEARCH_DATABASE_URL` | Optional PostgreSQL connection for the change-log worker |

Secrets must be at least 16 characters where enforced by the application. The
real `.env` file is ignored by Git and must never be committed.

## Local development

Install, type-check, test, and build with:

```cmd
npm.cmd install
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

Start the complete local stack with Docker:

```cmd
docker compose up --build
```

The API listens on `http://localhost:10000`; Typesense is available at
`http://localhost:8108`. The first API start creates the configured Typesense
collection and alias if they do not exist.

## HTTP API

### Health

- `GET /health` returns liveness: `{ "status": "ok" }`.
- `GET /ready` checks that the configured Typesense collection is reachable.

### Search

- `GET /v1/search` returns a global result list by default.
- `GET /v1/suggest` returns up to eight grouped suggestions and requires at
  least two query characters.

Both endpoints accept these query parameters:

| Parameter | Notes |
| --- | --- |
| `q` | Search text, up to 200 characters |
| `types` | Comma-separated `place`, `board`, or `collection` |
| `categories` | Comma-separated place categories |
| `province`, `country` | Place filters |
| `lat`, `lng`, `radiusKm` | Supply all three for geographic filtering |
| `limit` | 1–50 results; default 20 |
| `cursor` | Signed pagination cursor from the previous response |
| `mode` | `global` or `grouped` |

Anonymous requests see public, non-unlisted documents. Authenticated requests
may also see documents owned by or shared with the verified user. Invalid
Bearer tokens return `401`; malformed queries return `400`.

### Recommendations

`GET /v1/recommendations` requires a verified Supabase Bearer token and returns
the signed-in user's public place feed. It uses existing likes, favourites, and
favourite-collection additions, with category, province/country, freshness,
and like-count signals. It never records place views or stores personal signals
in Typesense. Use `categories`, `limit` (1-50), and the signed `cursor` returned
by the previous response. A response includes `personalized`,
`algorithmVersion`, `places`, and an optional `nextCursor`.

`GET /v1/places/:id/similar` returns up to twelve public places related to the
source place. It is an API-only surface for the Nomadeezee app and excludes the
source place itself. Both endpoints re-read place data through Supabase RLS;
the ordinary discovery feed remains the fallback when the service is unavailable.

### Indexing and rebuilds

`POST /internal/index` accepts a Supabase webhook payload and requires the
`X-Search-Webhook-Secret` header. It supports `INSERT`, `UPDATE`, and `DELETE`
for `places`, `trip_boards`, and `fav_categories`.

`POST /admin/rebuild-index` starts an asynchronous full rebuild and requires
`X-Search-Admin-Secret`. Poll
`GET /admin/rebuild-index/:jobId` with the same header for progress.

When `SEARCH_DATABASE_URL` is configured, the API also polls
`public.search_index_changes` every five seconds and retries failed index
operations while preserving the error on the change-log row.

## Deployment guide

Run the API and Typesense as separate services. Typesense needs persistent
storage mounted at `/data`; use its private hostname from the API service and
keep the Typesense API key in the platform secret manager.

For Render:

1. Create a private Typesense service using `typesense/typesense:30.2` with a
   persistent disk mounted at `/data` and port `8108`.
2. Create a web service from this repository with Node 22. Use `npm ci` as the
   build command and `npm start` as the start command.
3. Set the environment variables listed above. Set `TYPESENSE_HOST` to the
   private Typesense service hostname and `TYPESENSE_PROTOCOL=http`.
4. Set the web service health check path to `/health`.
5. After deployment, verify `/health`, `/ready`, and one authenticated search
   request. Treat `/ready` as the dependency check: a `503` means the API is
   live but Typesense is not available or its collection has not been created.

Do not run multiple API instances while relying on one in-process rebuild job
or the in-process anonymous rate-limit map. Typesense itself can be scaled
separately only when its persistence and clustering plan support it.

## Security checklist

- Keep `.env`, service-role keys, JWT secrets, and admin/webhook secrets out of
  GitHub and browser bundles.
- Use HTTPS for hosted API and Typesense connections where the network is not
  private.
- Rotate the three search secrets if they are exposed.
- Keep `SEARCH_CORS_ORIGINS` limited to the actual Nomadeezee web origins.
- Verify both the local commit and `origin/master` SHA after publishing changes.
