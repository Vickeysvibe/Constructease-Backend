# ConstructEase API

Backend for ConstructEase: purchase orders, goods receipts, stock, labour attendance, payments, worklog and reports for construction sites.

TypeScript · Express 5 · MongoDB (replica set) · zod. Two processes from one codebase: the **API** (`src/server.ts`) and the **worker** (`src/worker.ts`) that renders PDFs, builds Excel exports and geocodes check-ins.

- Contract: [`docs/API.md`](docs/API.md)
- Conventions for contributors: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Moving data from the old app: [`docs/MIGRATION.md`](docs/MIGRATION.md)

## Run locally

```bash
npm install
cp .env.example .env                       # fill in JWT_ACCESS_SECRET (openssl rand -base64 48)
docker run -d -p 27017:27017 --name ce-mongo mongo:7 --replSet rs0
docker exec ce-mongo mongosh --quiet --eval "rs.initiate()"
npm run dev                                # API on :8000
npm run dev:worker                         # jobs (PDF/Excel need PDF_BROWSER_WS_ENDPOINT or CHROME_PATH)
CE_OWNER_PASSWORD='<password>' npm run org:create -- --org "Acme Builders" --name "Owner Name" --email owner@example.com
```

Or the whole stack: `JWT_ACCESS_SECRET=$(openssl rand -base64 48) docker compose up --build`.

### Database

Use a **new, empty database** for this version and name it in the URI (`…/constructease?…`). Without a name MongoDB uses `test`, which is where the old app keeps its data. The old app and this one share six collection names (`sites`, `products`, `notes`, `payments`, `purchaseorders`, `purchasereturns`) with different shapes, so the API refuses to start on a database that still has old-app data. Copy old data across with `npm run migrate:legacy` (see docs/MIGRATION.md); the old database is only read.

## Checks

```bash
npm run typecheck && npm run lint && npm test   # tests use an in-memory MongoDB replica set
```

## Deploy

Build the image from `Dockerfile` and run it twice: once as the API (default command) and once as the worker (`node dist/worker.js`). Both need `MONGODB_URI` (a replica set — MongoDB Atlas works) and `JWT_ACCESS_SECRET`. Behind HTTPS on a different domain from the web app, set `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true` and list the web origin in `CORS_ORIGINS`. The service is a long-running process; serverless platforms are not supported.
