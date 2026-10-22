# aivora-backend

Shared Fastify API for the Android app and `aivora-admin`.

## Wave 0

- `GET /health` → `{ ok, db, redis, service, ts }`
- Prisma schema + initial migration
- Postgres + Redis via `docker compose`
- CI: lint, typecheck, tests, Semgrep

## Local

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:migrate
npm run dev          # http://localhost:8080
curl http://localhost:8080/health
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | watch mode |
| `npm test` | vitest |
| `npm run lint` | eslint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` | apply migrations |

## Render

Use `render.yaml` (Blueprint) to create free Postgres, Redis, and the web service. Set `CORS_ORIGIN` to your admin URL after admin is deployed.
