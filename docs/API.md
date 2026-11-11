# ConstructEase API v1 — contract

This file is the single source of truth for the backend and the frontend. If code and this file disagree, the code is wrong (or this file gets updated in the same change).

## Conventions

| Topic | Rule |
|---|---|
| Base path | `/api/v1` |
| Auth | `Authorization: Bearer <accessToken>` (15 min JWT). Refresh token lives in the httpOnly cookie `ce_rt` (path `/api/v1/auth`). `POST /auth/refresh` and `POST /auth/logout` also require the header `X-CE-CSRF: 1`. |
| IDs | 24-char ObjectId strings, always exposed as `id` (never `_id`). |
| Timestamps | ISO-8601 instants: `createdAt`, `updatedAt`. |
| Business dates | `YYYY-MM-DD` in the organisation's timezone (default `Asia/Kolkata`): `date`, `from`, `to`. Ranges are **inclusive** on both ends. |
| Money | Integer **paise**, fields end in `Paise` (`unitPricePaise: 41250` = ₹412.50). |
| Quantity | Number with at most 3 decimals (`qty: 12.5`). Stored internally as integer thousandths. |
| Tax | `taxRateBp` in basis points (`1800` = 18%). |
| Lists | `GET` lists return `{ items, page, pageSize, total }`. Query: `page` (1-based, default 1), `pageSize` (default 25, max 100), `q` (text search), `sort` (`field` or `-field`). |
| Empty list | `200` with `items: []` — never 404. |
| Errors | `application/problem+json`: `{ type, title, status, code, detail?, errors?: [{ path, message }] }`. `code` is a stable machine string (`VALIDATION_FAILED`, `NOT_FOUND`, `FORBIDDEN`, `UNAUTHENTICATED`, `CONFLICT`, `INSUFFICIENT_STOCK`, `INVALID_STATE`, `RATE_LIMITED`, `INTERNAL`). |
| Idempotency | `POST` that creates POs, goods receipts, returns, consumptions and payments accept `Idempotency-Key` (≤ 64 chars). A repeat within 24 h with the same key returns the original response. |
| Archive vs delete | Anything referenced by history (parties, products, sites, users) is archived, never hard-deleted. |
| Async work | PDF / Excel exports return `202 { jobId }`. Poll `GET /jobs/:id`, then download `GET /files/:fileId`. |

### Roles and permissions

Org role (`orgRole`): `owner` · `admin` · `member`. Site role (membership): `engineer` · `supervisor`.
Owner/admin have engineer rights on every site of the org. A `member` sees only sites they are a member of.

| Permission | owner/admin | engineer (site) | supervisor (site) |
|---|---|---|---|
| org settings, users, create sites | ✓ | – | – |
| site settings, members | ✓ | ✓ | – |
| masters write (parties, products, import) | ✓ | ✓ | labour only |
| purchase orders, returns | ✓ | ✓ | – |
| goods receipts, consumption | ✓ | ✓ | ✓ |
| stock adjustments | ✓ | ✓ | – |
| attendance (today & yesterday) | ✓ | ✓ | ✓ |
| attendance (older dates) | ✓ | ✓ | – |
| payments read/write, ledgers | ✓ | ✓ | – |
| reports, dashboard finance figures | ✓ | ✓ | – |
| notes, trackers | ✓ | ✓ | ✓ |
| read everything else on the site | ✓ | ✓ | ✓ |

Products are an org-wide catalogue: anyone may read; owner/admin and anyone who is engineer on ≥1 site may write.
Accessing another org's object, or a site the caller can't see, returns **404** (not 403) so existence never leaks.

---

## Auth

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password }` | `200 Session` + sets `ce_rt` cookie. 401 `INVALID_CREDENTIALS`. Rate limited (10/min/IP). |
| POST | `/auth/refresh` | – (cookie + `X-CE-CSRF`) | `200 Session` (rotates refresh token; reuse of an old token revokes the whole session family). |
| POST | `/auth/logout` | – | `204`, clears cookie, revokes session. |
| POST | `/auth/change-password` | `{ currentPassword, newPassword }` | `204`, revokes other sessions. |
| GET | `/me` | – | `200 Me` |

```ts
Session = { accessToken: string, expiresIn: number /* seconds */, user: User, org: Org }
Me      = { user: User, org: Org, sites: { id, name, role: 'engineer'|'supervisor' }[] }
User    = { id, name, email, phone, orgRole: 'owner'|'admin'|'member', status: 'active'|'disabled', createdAt, updatedAt }
```

There is no public sign-up. A new organisation is bootstrapped with `npm run org:create` on the server.

## Org & users  (owner/admin)

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/org` | – | `Org` (any member) |
| PATCH | `/org` | `Partial<{ name, logoUrl, description, address, phone, gstIn, timezone }>` | `Org` |
| GET | `/users` | `q, status, page, pageSize` | `List<User>` |
| POST | `/users` | `{ name, email, phone, password, orgRole }` | `201 User` · 409 `CONFLICT` email taken |
| PATCH | `/users/:userId` | `Partial<{ name, phone, orgRole, status }>` | `User` (disabling revokes sessions; the last owner can't be demoted/disabled) |
| POST | `/users/:userId/reset-password` | `{ newPassword }` | `204` |

```ts
Org = { id, name, logoUrl?, description?, address?, phone?, gstIn?, timezone, createdAt, updatedAt }
```

## Sites & members

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/sites` | `q, status, page, pageSize` | `List<Site>` (only sites visible to caller) |
| POST | `/sites` | `{ name, address }` | `201 Site` (owner/admin). Creates default trackers "To-do" and "Work done". |
| GET | `/sites/:siteId` | – | `Site` |
| PATCH | `/sites/:siteId` | `Partial<{ name, address }>` | `Site` |
| POST | `/sites/:siteId/archive` · `/restore` | – | `Site` (owner/admin) |
| GET | `/sites/:siteId/members` | – | `List<Member>` |
| PUT | `/sites/:siteId/members/:userId` | `{ role }` | `Member` (add or change role) |
| POST | `/sites/:siteId/members` | `{ name, email, phone, password, role }` | `201 Member` (creates org `member` user + membership) |
| DELETE | `/sites/:siteId/members/:userId` | – | `204` |

```ts
Site   = { id, name, address, status: 'active'|'archived', createdAt, updatedAt }
Member = { userId, name, email, phone, role: 'engineer'|'supervisor', status: User['status'] }
```

## Parties (vendors, clients, labour)

Parties belong to the org and are attached to one or more sites (`siteIds`). Site screens work through the site-scoped routes.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/sites/:siteId/parties` | `kind` (required), `q, status, page, pageSize, sort` | `List<Party>` attached to this site |
| POST | `/sites/:siteId/parties` | `PartyInput` **or** `{ existingPartyId }` | `201 Party` (attaches to site) · 409 duplicate (same kind + name (case-insensitive) + phone in org; `errors[0].message` holds the existing party id) |
| GET | `/sites/:siteId/parties/:partyId` | – | `Party` |
| PATCH | `/sites/:siteId/parties/:partyId` | `Partial<PartyInput>` (not `kind`) | `Party` |
| DELETE | `/sites/:siteId/parties/:partyId` | – | `204` detaches from this site (history keeps the reference) |
| GET | `/parties` | `kind, q, page, pageSize` | `List<Party>` org-wide (engineer+ anywhere) — for "add existing" |
| POST | `/parties/:partyId/archive` · `/restore` | – | `Party` (owner/admin) |
| GET | `/sites/:siteId/parties/:partyId/ledger` | `from?, to?` (default: `to` = today, `from` = 1 April of `to`'s financial year) | `Ledger` (vendor/client only, else 409 `INVALID_STATE`; party must be attached to the site; engineer+). Opening balance = this party's entries **on this site** before `from`; entries ordered by date then creation time with a running `balancePaise`. Org-level payments (no site) are not in a site ledger. |

```ts
PartyInput = {
  kind: 'vendor'|'client'|'labour', name: string, phone: string /* 10 digits */,
  address?: string, contactName?: string, gstIn?: string /* 15-char GSTIN */, pan?: string,
  category?: string, subCategory?: string,      // labour trade, e.g. "Mason" / "Helper"
  wageRatePaise?: number                         // labour: required, per shift
}
Party = PartyInput & { id, siteIds: string[], status: 'active'|'archived', createdAt, updatedAt }
Ledger = {
  party: Party, from, to, openingBalancePaise,
  entries: { id, date, sourceType: 'goods_receipt'|'purchase_return'|'payment', sourceId, reference, description, debitPaise, creditPaise, balancePaise }[],
  closingBalancePaise
}
```
Ledger sign: `balance = Σcredit − Σdebit`. Vendor: receipt = credit (we owe more), return = debit, payment out = debit → balance is what we still owe. Client: payment in = credit → balance is total received.

## Products (org catalogue)

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/products` | `q, category, status, page, pageSize, sort` | `List<Product>` |
| POST | `/products` | `ProductInput` | `201 Product` · 409 duplicate name |
| GET / PATCH | `/products/:productId` | `Partial<ProductInput>` | `Product` |
| POST | `/products/:productId/archive` · `/restore` | – | `Product` |

```ts
ProductInput = { name, unit /* 'bag', 'cu.m', 'tonne', 'nos', … */, category?: string, description?: string, defaultTaxRateBp?: number /* default 1800 */ }
Product = ProductInput & { id, status: 'active'|'archived', createdAt, updatedAt }
```

## Imports & exports

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/sites/:siteId/imports/parties` | multipart `file` (.xlsx ≤ 5 MB), query `kind`, `dryRun=true|false` | `ImportResult` |
| POST | `/imports/products` | multipart `file`, `dryRun` | `ImportResult` |
| GET | `/imports/templates/:entity` | entity = `vendor`·`client`·`labour`·`product` | xlsx template download |
| POST | `/sites/:siteId/exports` | `{ entity: 'vendor'|'client'|'labour'|'product'|'team' }` | `202 { jobId }` |

```ts
ImportResult = { dryRun: boolean, total: number, valid: number, created: number, updated: number, skipped: number,
                 rows: { row: number, status: 'create'|'update'|'skip'|'error', data: object, errors: { path, message }[] }[] }
```
A commit (`dryRun=false`) is all-or-nothing: any `error` row → 422 (problem body carries the full `result: ImportResult`) and nothing is written. Matching existing rows: parties by (kind, name case-insensitive, phone), products by name (case-insensitive) → `update`; repeated rows within the file → `skip`. Accepted headers include legacy names (`Phone No`, `Wages Per Shift`, `Owner Name`, …); wage rate and prices are in rupees in sheets.

## Purchasing

### Purchase orders
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/sites/:siteId/purchase-orders` | `status, vendorId, q, from, to, page, pageSize, sort` | `List<PurchaseOrderSummary>` |
| POST | `/sites/:siteId/purchase-orders` | `POInput` | `201 PurchaseOrder` (status `draft`, number assigned) |
| GET | `/sites/:siteId/purchase-orders/:poId` | – | `PurchaseOrder` |
| PATCH | `/sites/:siteId/purchase-orders/:poId` | `Partial<POInput>` | `PurchaseOrder` — only while `draft` (else 409 `INVALID_STATE`) |
| POST | `…/:poId/send` | – | `PurchaseOrder` draft → `sent` |
| POST | `…/:poId/cancel` | `{ reason? }` | only if nothing received → `cancelled` |
| POST | `…/:poId/pdf` | `{ template?: 'classic'|'compact'|'detailed' }` | `202 { jobId }` |

```ts
POInput = { vendorId, date, expectedDate?, transport?, notes?,
            lines: { productId, qty, unitPricePaise?: number /* default 0 */, taxRateBp?: number /* default product's */ }[] /* ≥1 */ }
POLine  = { id, productId, productName, unit, qty, unitPricePaise, taxRateBp, amountPaise, taxPaise, totalPaise,
            receivedQty, returnedQty, pendingQty }
PurchaseOrder = { id, number /* PO-2026-0001 */, siteId, vendor: { id, name, gstIn? }, date, expectedDate?, transport?, notes?,
                  status: 'draft'|'sent'|'partially_received'|'received'|'cancelled',
                  lines: POLine[], subtotalPaise, taxPaise, totalPaise, receivedValuePaise,
                  receipts: { id, number, date, totalPaise }[], returns: { id, number, date, totalPaise }[], createdAt, updatedAt }
PurchaseOrderSummary = Omit<PurchaseOrder, 'lines'|'receipts'|'returns'> & { lineCount: number }
```
Status rules: `sent` → `partially_received` after the first receipt → `received` when every line has `pendingQty = 0`. Returns never re-open a received PO (`pendingQty = qty − receivedQty`).
Details: `vendorId` must be an active `vendor` attached to this site and every `productId` an active product of the org, else 422 (`errors[].path` `vendorId` / `lines.N.productId`). `expectedDate ≥ date`. The number's year is the PO `date`'s year. PATCH with `lines` replaces all lines (new line ids); sending `""` for `transport`/`notes` clears them. `send` from anything but `draft`, and `cancel` from anything but `draft`/`sent`, is 409 `INVALID_STATE`; a cancelled PO carries `cancelReason?`. `receivedValuePaise` = Σ `totalPaise` (incl. tax) of its goods receipts. List: default sort `-date`; `sort` accepts `date`, `number`, `totalPaise`, `createdAt`, `status`; `q` searches number and vendor name; `from`/`to` are each optional. `…/pdf` needs only read access; the job fails with "PDF rendering is not configured…" when neither `PDF_BROWSER_WS_ENDPOINT` nor `CHROME_PATH` is set; the file is named `PO-2026-0001.pdf`.

### Goods receipts (material inward) — supervisors allowed
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/sites/:siteId/goods-receipts` | `poId, vendorId, from, to, page, pageSize` | `List<GoodsReceiptSummary>` |
| POST | `/sites/:siteId/goods-receipts` | `GRInput` | `201 GoodsReceipt` |
| GET | `/sites/:siteId/goods-receipts/:receiptId` | – | `GoodsReceipt` |

```ts
GRInput = { poId, date, challanNo?, vehicleNo?, notes?,
            lines: { poLineId, qty, unitPricePaise?: number /* default PO line price */, taxRateBp?: number }[] }
GoodsReceipt = { id, number /* GR-2026-0001 */, poId, poNumber, vendor: { id, name }, date, challanNo?, vehicleNo?, notes?,
                 lines: { id, poLineId, productId, productName, unit, qty, unitPricePaise, taxRateBp, amountPaise, taxPaise, totalPaise }[],
                 subtotalPaise, taxPaise, totalPaise, createdBy: { id, name }, createdAt }
```
Rules: PO must be `sent` or `partially_received`; each `qty ≤ pendingQty` (409 `INVALID_STATE` with per-line `errors`). In one transaction: receipt + stock movements (+qty) + vendor ledger credit + PO status update. Receipts are immutable; corrections go through returns.
Details: a `poLineId` that isn't on the PO, or the same `poLineId` twice, is 422. `poId` of another site/org is 404. The ledger credit is the receipt's `totalPaise` (incl. tax); stock movements carry `unitCostPaise` = the receipt line price (excl. tax). `GoodsReceiptSummary = Omit<GoodsReceipt, 'lines'> & { lineCount }`; list `q` searches number, PO number, vendor and challan.

### Purchase returns
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/sites/:siteId/purchase-returns` | `poId, from, to, page, pageSize` | `List<PurchaseReturnSummary>` |
| POST | `/sites/:siteId/purchase-returns` | `{ poId, date, reason?, lines: { poLineId, qty }[] }` | `201 PurchaseReturn` |
| GET | `/sites/:siteId/purchase-returns/:returnId` | – | `PurchaseReturn` |
| POST | `…/:returnId/pdf` | `{ template? }` | `202 { jobId }` |

Rules: `qty ≤ receivedQty − returnedQty` for the line and `≤ on-hand stock` (409 `INSUFFICIENT_STOCK`). Price = quantity-weighted average receipt price of that line. In one transaction: return + stock movements (−qty) + vendor ledger debit.
`PurchaseReturn` mirrors `GoodsReceipt` (number `PR-2026-0001`, `reason`, no challan/vehicle).
Details: both limits (returnable on the line, on-hand on the site — summed per product across lines) fail with 409 `INSUFFICIENT_STOCK` and per-line `errors` (`lines.N.qty`). Draft/cancelled PO → 409 `INVALID_STATE`. The average price is over every receipt line for that PO line (excl. tax); tax uses the PO line's `taxRateBp`. The ledger debit is the return's `totalPaise`. Return PDFs accept only `template: 'classic'` (default).

## Inventory

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/sites/:siteId/stock` | `q, category` | `{ items: StockItem[] }` (all products with any movement on the site) |
| GET | `/sites/:siteId/stock/movements` | `productId, type, from, to, page, pageSize` | `List<StockMovement>` |
| POST | `/sites/:siteId/consumptions` | `{ date, notes?, lines: { productId, qty, usedFor?: string }[] }` | `201 { movements: StockMovement[] }` · 409 `INSUFFICIENT_STOCK` |
| POST | `/sites/:siteId/stock-adjustments` | `{ date, productId, qty /* signed */, reason }` | `201 StockMovement` (engineer+) |

```ts
StockItem = { productId, productName, unit, category?, receivedQty, returnedQty, consumedQty, adjustedQty, onHandQty, avgCostPaise, valuePaise }
StockMovement = { id, productId, productName, unit, date, type: 'receipt'|'return'|'consumption'|'adjustment', qty /* signed */,
                  unitCostPaise, sourceType, sourceId, reference, notes?, createdBy: { id, name }, createdAt }
```
Stock is never stored as a counter: on-hand = Σ movements. Movements are append-only.
Details: `receivedQty`/`returnedQty`/`consumedQty` are positive, `adjustedQty` is signed. `avgCostPaise` = quantity-weighted receipt cost net of returns (0 if nothing received); `valuePaise = round(onHandQty × avgCostPaise)`. Consumption and adjustment movements are costed at that average. Consumption/adjustment `productId` must be a product of the org (else 422); several consumption lines for one product are checked against stock together, failing with per-line `errors` (`lines.N.qty`). `usedFor` (else `notes`) is stored as the movement's `notes`; the adjustment `reason` likewise. Adjustment `qty ≠ 0`; a negative one that would take on-hand below 0 is 409 `INSUFFICIENT_STOCK`. `stock-adjustments` also accepts `Idempotency-Key`. Movements list is sorted newest `date` first; `sourceId` groups the movements of one receipt/return/consumption.

## Workforce

### Labour attendance
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/sites/:siteId/attendance` | `date` (default today) | `AttendanceSheet` |
| PUT | `/sites/:siteId/attendance` | `{ date, entries: { labourId, status: 'present'|'absent', shifts?: number /* 0.5 steps, 0–3, default 1 when present */ }[] /* 1–500 */, refreshRates?: boolean }` | `AttendanceSheet` |

```ts
AttendanceSheet = { date, editable: boolean,
  rows: { labourId, name, phone, category?, subCategory?, wageRatePaise,
          entry: { id, status, shifts, wageRatePaise /* snapshot */, wagePaise } | null }[],
  summary: { present, absent, unmarked, shifts, wagesPaise, byCategory: { category, present, shifts }[] } }
```
Rules: no future dates (422 on `date`); supervisors may edit only today and yesterday (else 403); `editable` tells the caller whether they may save this date. A PUT upserts only the entries sent, in one transaction. Present needs `shifts` ≥ 0.5; absent means `shifts` 0 (sending more is 422). Each `labourId` must be an active `labour` party attached to the site (else 422 with `errors[].path` `entries.N.labourId`). A labourer can be **present** on only one site per day across the org: present on another site that day → 409 with per-entry `errors` (path `entries.N.labourId`); being absent on several sites is allowed. The wage rate is copied onto the entry when it is created and is not changed by later rate edits (an engineer can re-save the day to refresh it explicitly with `refreshRates: true`; supervisors get 403). `wagePaise = round(shifts × wageRatePaise)`. Rows list the site's active labour plus anyone with an entry that day (so detached labour still counts); `byCategory` uses `"Uncategorised"` for labour without a category.

### Check-ins (any site member, for themselves)
| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/sites/:siteId/checkins` | `{ type: 'in'|'out', lat, lng, accuracyM? }` | `201 CheckinDay` (address resolved later by the worker) |
| GET | `/sites/:siteId/checkins` | `date` (default today), `userId?` | `{ items: CheckinDay[] }` (supervisors only see their own) |

```ts
CheckinDay = { id, user: { id, name }, date, events: { type, at, lat, lng, accuracyM?, address? }[], firstIn?, lastOut?, workedMinutes }
```
Rules: alternating in/out (409 if checking in twice or checking out while not checked in). `date` is today in the org timezone; a check-out after midnight closes the previous day's open check-in. `lat` ∈ [-90, 90], `lng` ∈ [-180, 180]. `workedMinutes` sums closed in→out pairs. Supervisors asking for another `userId` get 403. Addresses are filled by the `workforce.geocode` job (skipped when `GEOCODER_URL` is not configured); geocoding never affects the check-in.

## Finance

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/sites/:siteId/payments` | `category, direction, partyId, from, to, status, page, pageSize, sort` | `List<Payment>` |
| POST | `/sites/:siteId/payments` | `PaymentInput` | `201 Payment` |
| GET / PATCH | `/sites/:siteId/payments/:paymentId` | `Partial<PaymentInput>` | `Payment` (edit re-posts the ledger entry) |
| POST | `/sites/:siteId/payments/:paymentId/void` | `{ reason }` | `Payment` status `void`, ledger entry reversed |
| GET / POST | `/payments` | same as above, org-level (no site; general expenses), owner/admin | `List<Payment>` / `201 Payment` |
| GET / PATCH | `/payments/:paymentId` · POST `/payments/:paymentId/void` | org-level payments, owner/admin | `Payment` |

```ts
PaymentInput = { date, direction: 'out'|'in', category: 'vendor'|'client'|'labour'|'other',
                 partyId?: string /* required for vendor|client|labour and must be that kind */,
                 amountPaise: number /* > 0 */, method?: 'cash'|'bank'|'upi'|'cheque'|'other', reference?, description?,
                 quantity?, unit?, unitCostPaise? }
Payment = PaymentInput & { id, siteId: string|null, party?: { id, name, kind }, status: 'posted'|'void', voidReason?, createdBy: { id, name }, createdAt, updatedAt }
```
Rules: `partyId` must be a party of the category's kind attached to the site (org-level: any party of that kind in the org), else 422 on `partyId`; `other` payments must not have a party. Vendor and client payments post a ledger entry (`in` = credit, `out` = debit); labour and other payments post none (labour balances come from attendance). PATCH accepts `null` to clear optional fields (`partyId`, `method`, `reference`, `description`, `quantity`, `unit`, `unitCostPaise`); if the posting changes, the old ledger entry is reversed and a new one posted in the same transaction. Void payments can't be edited or voided again (409 `INVALID_STATE`). List default sort is `-date`; `sort` accepts `date`, `amountPaise`, `createdAt`; `q` searches reference/description. `POST` creates accept `Idempotency-Key`.

## Worklog (to-do & work done) and notes

Trackers are tables with user-defined columns. Every site gets "To-do" (`kind: 'todo'`) and "Work done" (`kind: 'work'`).

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/sites/:siteId/trackers` | – | `{ items: Tracker[] }` |
| POST | `/sites/:siteId/trackers` | `{ name, kind, columns: ColumnInput[] }` | `201 Tracker` |
| PATCH | `/sites/:siteId/trackers/:trackerId` | `{ name?, columns?: (ColumnInput & { key? })[] }` | `Tracker` — columns sent replace the list; a column whose `key` is omitted is new; a removed key is deleted from every row |
| DELETE | `/sites/:siteId/trackers/:trackerId` | – | `204` (409 if it has rows, unless `?force=true`) |
| GET | `/sites/:siteId/trackers/:trackerId/rows` | `q, done, page, pageSize, sort` | `List<TrackerRow>` |
| POST | `…/rows` | `{ values, done? }` | `201 TrackerRow` |
| PATCH | `…/rows/:rowId` | `{ values?, done? }` (values merge) | `TrackerRow` |
| DELETE | `…/rows/:rowId` | – | `204` |
| GET | `/sites/:siteId/notes` | `q, page, pageSize` | `List<Note>` |
| POST | `/sites/:siteId/notes` | `{ title, body?, link? }` | `201 Note` |
| PATCH / DELETE | `/sites/:siteId/notes/:noteId` | `Partial<…>` | `Note` / `204` |

```ts
ColumnInput = { label: string, type: 'text'|'number'|'date'|'status', required?: boolean, options?: string[] /* status */ }
Tracker     = { id, name, kind: 'todo'|'work'|'custom', columns: (ColumnInput & { key: string })[], rowCount, createdAt, updatedAt }
TrackerRow  = { id, values: Record<string, string|number|null>, done: boolean, createdBy: { id, name }, createdAt, updatedAt }
Note        = { id, title, body, link?, createdBy: { id, name }, createdAt, updatedAt }
```
Values are validated against the column type (`date` = `YYYY-MM-DD`, `status` ∈ options).

Details:
- **Columns.** `key` is generated by the server (`c_…`) and is never sent on create. Labels are unique (case-insensitive) within a tracker, max 30 columns, a `status` column needs ≥ 1 unique option and other types take no options. Responses always include `required` and `options` (`[]` for non-status). The default trackers use fixed keys: To-do `c_task`, `c_start`, `c_end`, `c_status`; Work done `c_title`, `c_desc`, `c_date`. `POST` `kind` defaults to `custom`.
- **Column edits.** A new column leaves existing rows untouched. If you change a column's `type`, or remove a status option that rows still use, every stored value must still be valid. Otherwise the server returns `409 CONFLICT` with `errors[{ path: 'columns.<i>', message }]`. A `key` that isn't in the tracker → `422`.
- **Row values.** An unknown key → `422` (`errors[].path = 'values.<key>'`). `text` is trimmed, ≤ 2000 chars; `number` must be a finite JSON number (`"5"` is rejected). `null` or `""` clears a cell, but a required column can't be cleared. On create, every required column needs a value. On `PATCH`, only the keys you send are checked, so rows created before a required column was added stay editable.
- **Rows list.** `q` searches text and status cells. `done=true|false`. `sort` = `createdAt` | `updatedAt` | a column key (prefix `-` for descending). An unknown key falls back to the default order, oldest first (`createdAt`).
- **Notes.** `link` must be an `http(s)` URL. On `PATCH`, `link: null` or `""` removes it. The list is newest first by default; `sort` = `title` | `createdAt` | `updatedAt`, and `q` searches title and body.

## Dashboard

| Method | Path | Response |
|---|---|---|
| GET | `/dashboard` | `{ sites: { id, name, status, today: { labourPresent, checkedIn }, openPOs, monthSpendPaise? }[] }` |
| GET | `/sites/:siteId/dashboard` | `SiteDashboard` (finance fields omitted for supervisors) |

```ts
SiteDashboard = {
  today: { date, labourPresent, labourAbsent, shifts, wagesPaise?, checkedIn: { userId, name, at }[] },
  purchasing: { openPOs, partiallyReceived, awaitingDelivery: { id, number, vendorName, pendingLines }[] },
  finance?: { vendorPayablePaise, clientReceivedPaise, monthPaymentsOutPaise },
  stock: { items: number, valuePaise?: number },
  series: { month /* YYYY-MM */, materialSpendPaise, wagesPaise, paymentsOutPaise, paymentsInPaise }[]   // last 6 months incl. current
}
```

## Reports (engineer+)

All accept `from`, `to` (inclusive, max 366 days). Add `format=xlsx` to get `202 { jobId }` instead of JSON.

| Path | Extra query | JSON response |
|---|---|---|
| `/sites/:siteId/reports/labour-wages` | `category?` | `{ from, to, days: string[], rows: { labourId, name, category, subCategory, shiftsByDate: Record<date, number>, days, shifts, wagesPaise, paidPaise, balancePaise }[], totals: { shifts, wagesPaise, paidPaise, balancePaise } }` |
| `/sites/:siteId/reports/vendor-ledger` | `vendorId?` | with `vendorId`: `Ledger`; without: `{ rows: { vendorId, name, openingBalancePaise, receivedPaise, returnedPaise, paidPaise, closingBalancePaise }[], totals }` |
| `/sites/:siteId/reports/payments` | `category?, direction?` | `{ rows: Payment[], totals: { inPaise, outPaise, byCategory: { category, inPaise, outPaise }[] } }` |
| `/sites/:siteId/reports/stock` | `productId?` | `{ rows: { productId, productName, unit, openingQty, receivedQty, returnedQty, consumedQty, adjustedQty, closingQty, closingValuePaise }[] }` |
| `/sites/:siteId/reports/site-summary` | – | `{ materials: { receivedPaise, returnedPaise, netPaise }, labour: { shifts, wagesPaise }, payments: { inPaise, outPaise }, byMonth: { month, materialsPaise, wagesPaise, paymentsOutPaise, paymentsInPaise }[] }` |

## Jobs & files

| Method | Path | Response |
|---|---|---|
| GET | `/jobs/:jobId` | `{ id, type, status: 'queued'|'running'|'done'|'failed', error?, file?: { id, filename, contentType, size } }` |
| GET | `/files/:fileId` | the file stream (`Content-Disposition: attachment`, RFC 5987 filename) |

Only the user's org can see a job or file.
