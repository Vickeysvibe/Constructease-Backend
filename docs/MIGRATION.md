# Legacy data migration

One-time move of the old ConstructEase (legacy JS app) MongoDB data into the new model.
Code: `src/scripts/migrate-legacy/` (`index.ts` CLI, `migrate.ts` orchestration, `steps/*` per domain, `clean.ts` value cleaning).
Test: `test/migration.test.ts`.

## Running it

```bash
# 1. Point MONGODB_URI (.env) at the NEW database (must be a replica set — the migration uses transactions).
# 2. Rehearse: reads everything, maps and validates every document, writes nothing (not even indexes).
npm run migrate:legacy -- --source-uri "mongodb://…/constructease_old" --dry-run
# 3. Read the printed summary / migration-report-<timestamp>.json, fix source data if needed, then:
npm run migrate:legacy -- --source-uri "mongodb://…/constructease_old"
```

| Option | Default | Meaning |
|---|---|---|
| `--source-uri` | – (required) | old database (read only — the migration never writes to it) |
| `--dry-run` | off | map + validate, write nothing, print the same report |
| `--org-tz` | `Asia/Kolkata` | timezone stored on every new organisation and used to turn old instants into business dates |
| `--report-dir` | `.` | where `migration-report-<timestamp>.json` is written |

- Source and target must be **different databases** (old and new collections share names such as `sites`); the script refuses otherwise.
- Exit code `2` when the report has errors, `1` on a crash, `0` otherwise.
- **Re-runnable.** Every migrated record is recorded in `legacy_id_map` `{ kind, oldId, newId, orgId }` in the same transaction as the documents it produced. A re-run skips those (`alreadyMigrated` in the report) and only picks up what failed or is new. Run it again after fixing source data.
- Each old record (one old PO together with all its inwards and returns) is one transaction, so a crash never leaves half a record behind.
- All writes go through the new mongoose models (validation applies); `createdBy`/`markedBy` is the org owner (the old engineer). Old `createdAt` timestamps are kept where the new model has them.
- Load: the script reads the old collections into memory (fine for the old app's volume — tens of thousands of documents).
- The new orgs are created by the migration, so keep the new app closed to users until the migration is done (document numbers are assigned deterministically, see below).

## What maps to what

Old collections are mongoose's default plurals of the old model names: `engineers, supervisors, sites, clients, vendors, labours, products, purchaseorders, materialinwards, materials, purchasereturns, labourattendances, supervisorattendances, payments, todos, works, notes`.

| Old | New | Notes |
|---|---|---|
| `Engineers` | `Organization` (name = companyName, logoUrl = companyLogo, description = companyDesc, address, phone, timezone = `--org-tz`) + owner `User` | `password` (bcrypt `$2b$`) is copied as-is — bcryptjs verifies it, so owners keep their password. Email already used in the target → error, org skipped. |
| `Supervisors` | org `member` `User` | bcrypt password kept; a plaintext one (old Excel import bug) gets a random unusable hash and is listed in **mustResetPassword**. `isDel` → `status: disabled`. Email already used (e.g. by an engineer) → error. |
| `Sites.supervisorsId` | `Membership` role `supervisor` | `role: global` supervisors (who saw every site of their engineer in the old app) get a membership on **every** site of the org. |
| `Sites` | `Site` (name = siteName, address = siteAddress) | plus the default "To-do" / "Work done" trackers, created with the worklog module's `DEFAULT_TRACKERS` (same as `POST /sites`). |
| `Vendors` / `Clients` / `Labours` | `Party` kind vendor / client / labour | Deduped per org by (kind, `nameKeyOf(name)`, 10-digit phone); `siteIds` = union of old sites (Labour.siteId is an array). First record wins, later duplicates fill blanks (**partyMerges**). Vendor ownerName → contactName, gstIn only if it is a valid GSTIN. Client panGstNo → gstIn if GSTIN, else pan if PAN, else dropped (**droppedTaxIds**). Labour wagesPerShift (₹) → wageRatePaise; category/subCategory kept. Labour `isDel` → archived (when every duplicate is deleted). |
| invalid phones | | digits only, `+91`/`0` prefix stripped. Not 10 digits: skipped (**invalidPhones**) unless history references the record (vendor of a PO/material, labour in attendance, or a payment with its name on its site) — then imported with the cleaned digits (`0000000000` if none) and listed so someone fixes it. |
| `Products` (per site) | `Product` (org catalogue) | Deduped per org by name (**productMerges**, unit differences noted). `defaultTaxRateBp` 1800. |
| `PurchaseOrders` | `PurchaseOrder` | Number `PO-<year>-NNNN` (year of the PO date) in date order per org. Lines from `order[]` (qty = requiredQty); unit price / tax from the first material received on that line, else 0 / product default. Status: no inward → `sent`; every line fully received → `received`; else `partially_received` (never `cancelled`/`draft`). Vendor attached to the PO's site if it wasn't. |
| `MaterialInwards` + `Materials` | `GoodsReceipt` (`GR-…`), `StockMovement` receipt rows, vendor `LedgerEntry` credit | Materials are matched to PO lines by product, filling duplicate product lines in line order; over-receipts stay on the last matching line, received-but-not-ordered products get an extra PO line (**purchaseOrderAdjustments**). Totals are recomputed with `priceLine` (tax = material.tax %); differences > ₹1 from the old grandTotal → **receiptTotalMismatch**. |
| `Materials.usedQty` | one `StockMovement` consumption per material | `−usedQty`, unitCost = material price, `sourceType: legacy`, reference "Opening usage (migrated)", dated at the material's last update (not before its receipt). Usage above supplied − returned is clamped (**usageClamped**). |
| `Materials.availableQty` | – | ignored (corrupted by an old hook bug); where it ≠ supplied − used − returned → **availableQtyMismatch**. |
| `PurchaseReturns` | `PurchaseReturn` (`PR-…`), `StockMovement` return rows (−qty), vendor `LedgerEntry` debit | `order[].materialId` → product + the PO line(s) that material was received on; price = material price, tax = return line tax %. Returning more than received is capped. |
| `LabourAttendances` (site/day doc) | `AttendanceEntry` per labourer | date = old date as an `--org-tz` calendar day; present → shifts rounded to 0.5 in [0.5, 3] (**attendanceAdjustments**), absent → 0; wageRatePaise = the labourer's current wagesPerShift. Present on two sites the same day, or twice on one site: the first (by old createdAt) is kept, the rest are listed in **doubleBookings**. |
| `SupervisorAttendances` | `CheckinDay` per supervisor/site/day | `checkin[i]`/`checkout[i]` pairs; a checkout equal to its checkin (the old default) means "never checked out" and is dropped; an unclosed check-in followed by another one is dropped (**checkinAdjustments**). Day = first check-in's day in `--org-tz`. The day's single location is put on every event. |
| `Payments` | `Payment` (+ `LedgerEntry` for vendor/client) | type vendor/client/labour/others → category vendor/client/labour/other. Party resolved by name (case/whitespace-insensitive) in the org, preferring parties on the payment's site (**ambiguousPayments** when several match). Unresolved → category `other`, description `[unmatched: <name>] …` (**unmatchedPayments**). Amount: client = paymentReceived (direction `in`), others = amount (`out`); ≤ 0 → skipped (**skippedPayments**). Client paymentAs → method (cash/upi/cheque/bank/other) and "Paid by … via …" in the description. No site → org-level payment (engineer "others"). quantity/unit/costPerUnit kept. Vendor payment = debit, client payment = credit. |
| `Todos` | rows of the site's "To-do" tracker | task → `c_task`, start/end → `c_start`/`c_end` (dates). Every `additionalCols` key becomes a text column labelled with the key (a key clashing with a default column is labelled "<key> (legacy)"; beyond 30 columns → **trackerColumns**). Empty values are not stored. |
| `Works` | rows of the "Work done" tracker | title → `c_title`, description → `c_desc`, date → `c_date`, additionalCols as above. |
| `Notes` | `Note` | context → body; sheetsLink → link when it is an http(s) URL, otherwise appended to the body as "Link: …". |
| document counters | `Counter` | set (`$max`) to the highest PO/GR/PR number used per org and year, so new documents continue the sequence. |

Numbering is deterministic: an old record's number is its rank by (business date, createdAt, id) within its org, prefix and year, so a re-run produces the same numbers. A failed record leaves a gap in its sequence.

## Report

Printed as a table and written in full to `migration-report-<timestamp>.json`:

- `counts.<entity>`: `read` (old records), `created` (new documents), `merged` (old records folded into an existing new document — party/product dedupe, several old check-in rows of one day), `alreadyMigrated`, `skipped` (intentionally not imported, see issues), `errors`.
- `issues`: `errors`, `mustResetPassword`, `invalidPhones`, `droppedTaxIds`, `partyMerges`, `productMerges`, `truncated` (text cut to the new model's limits), `purchaseOrderAdjustments`, `receiptTotalMismatch`, `availableQtyMismatch`, `usageClamped`, `orphanMaterials` (materials no inward lists — not imported), `doubleBookings`, `attendanceAdjustments`, `checkinAdjustments`, `unmatchedPayments`, `ambiguousPayments`, `skippedPayments`, `trackerColumns`, `notes`.
- `lossy`: the fixed list below.

## Lossy by design

- **Wage history**: the old app stored only the labourer's current `wagesPerShift`; every migrated attendance entry is priced at that rate.
- **Material usage** had no date or purpose; it becomes one "Opening usage (migrated)" consumption per material.
- **availableQty** is discarded (rebuilt from movements).
- **Payments** referenced parties by free-text name; unmatched ones lose the link (category `other`).
- **Check-in locations**: one per day in the old data, copied to every event; unclosed check-ins have no check-out.
- **Plaintext supervisor passwords** cannot be carried over — those users must get a reset (`POST /users/:userId/reset-password`).
- **Products** lose their per-site identity (merged by name); old products had no tax rate.
- **Duplicate parties** keep the first record's details (address, contact, wage rate).
- **To-dos** had no status/done flag; old custom columns become text columns.
- Old engineer/supervisor `address` and supervisor `role` have no place in the new model (role is expressed as memberships).

## Verifying a run

1. The report has no `errors` (or each is understood). Every old record is counted once as created, merged, alreadyMigrated, skipped or errors (when a whole PO fails, its materials are counted as errors).
2. Run it again: every `created` is 0 and nothing changes.
3. Spot checks per org in the app (or via the API):
   - owners can sign in with their old password; supervisors in `mustResetPassword` get a reset;
   - `GET /sites/:id/stock` on-hand = Σ old suppliedQty − usedQty − returnQty per product (compare with `availableQtyMismatch`);
   - vendor ledger (`GET /sites/:id/parties/:id/ledger`) = Σ receipts − returns − vendor payments;
   - PO list statuses, `GET /sites/:id/attendance?date=…` head counts, trackers and notes per site.
4. Hand `invalidPhones`, `unmatchedPayments`, `doubleBookings` and `mustResetPassword` to the customer for clean-up.
