# ConstructEase API — architecture & conventions

TypeScript · Express 5 · Mongoose 8 (MongoDB **replica set**, for transactions) · zod · vitest.

```
src/
  core/        config (validated at boot), db (tenantGuard, withTransaction, serialize), http (handler, lists),
               auth (sessions, requireAuth), access (siteScope, permissions), errors (problem+json),
               records (counters, audit, idempotency), jobs (queue + GridFS files), excel, units (money/qty/dates), hooks
  modules/     one folder per domain: models.ts · schemas.ts · (service.ts) · routes.ts
  scripts/     create-org, migrate-legacy
  templates/   PDF templates (Handlebars)
  app.ts       assembles middleware + module routes;  server.ts  API process;  worker.ts  job runner
docs/API.md    the contract — read before changing any route
test/          vitest + supertest against an in-memory replica set (test/helpers.ts: world(), auth(), sitePath())
```

## Rules a module must follow

1. **Tenancy.** Every tenant model has `orgId` and `.plugin(tenantGuard)`. Every query filters by `orgId: ctx.orgId` (and `siteId: site.id` for site data). Never `findById` on tenant data — use `findOne({ _id, orgId })`. `skipTenantGuard` is only for login, the worker claim loop and scripts.
2. **Routes.** Export a `ModuleRoutes` object from `routes.ts` and list it in `src/modules/index.ts`. Site routes go in `site(r)` and get `req.site` from `siteScope`; guard each with `requireSite("<permission>")` from `core/access`. Org routes go in `org(r)`.
3. **Validation.** Wrap every route in `handler({ body, query, params }, fn)`. Bodies are `z.object(...).strict()` for updates so unknown fields (orgId, status, siteIds…) are rejected rather than silently written. Ids are `objectId`.
4. **Errors.** Throw helpers from `core/errors` (`notFound`, `forbidden`, `conflict`, `invalidState`, `insufficientStock`, `validationFailed`). Never `res.status(500)` by hand. Another org's or an invisible object is **404**.
5. **Money / qty / dates.** Paise integers (`paise`, `priceLine`), quantities stored as `qtyMilli` integers (`toMilli`/`fromMilli`), business dates are `YYYY-MM-DD` strings in `ctx.tz` (`todayIn(ctx.tz)`, `isoDate`, `dateRange()`). No `new Date()` for business days.
6. **Multi-document writes** go in `withTransaction(async (session) => …)` and pass `{ session }` to every write. Stock changes are rows in `StockMovement` (`modules/inventory/models.ts`); party balances are rows in `LedgerEntry` (`modules/finance/models.ts`). Both are append-only.
7. **Creates that move money or stock** use the `idempotent` middleware (`core/records`) and write an `audit(...)` entry.
8. **Responses** use explicit `publicX()` mappers (or `serialize`) — `id` not `_id`, no `orgId`, no secrets. Lists return `{ items, page, pageSize, total }` via `paginate`.
9. **Slow work** (PDF, Excel, geocoding) is a job: `enqueue(ctx, type, payload)` → `registerJobHandler(type, fn)` → `202 { jobId }`.
10. **Tests** live in `test/<module>.test.ts`, use `world()` and cover: happy path, validation, permissions per role, cross-org 404, and the business invariants of the module.

Run: `npm run typecheck && npm run lint && npm test`.
