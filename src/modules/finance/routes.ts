import type { Router, RequestHandler } from "express";
import type { Types } from "mongoose";
import { handler } from "@/core/http";
import { requireOrgAdmin, requireSite } from "@/core/access";
import type { SiteContext } from "@/core/context";
import { idempotent } from "@/core/records";
import type { ModuleRoutes } from "@/modules/registry";
import { ledgerQuery, partyParams, paymentInput, paymentListQuery, paymentParams, paymentPatch, voidInput } from "./schemas";
import { createPayment, getPayment, listPayments, partyLedger, updatePayment, voidPayment } from "./service";

/**
 * Payment routes are identical for a site (`/sites/:siteId/payments`, engineer+) and the org
 * (`/payments`, owner/admin, siteId null = general expenses); only the guard and scope differ.
 */
function paymentRoutes(
  r: Router,
  guards: { read: RequestHandler; write: RequestHandler },
  scope: (a: { site: SiteContext }) => Types.ObjectId | null,
) {
  r.get(
    "/payments",
    guards.read,
    handler({ query: paymentListQuery }, async (a) => listPayments(a.ctx, scope(a), a.query)),
  );
  r.post(
    "/payments",
    guards.write,
    idempotent,
    handler({ body: paymentInput }, async (a) => createPayment(a.ctx, scope(a), a.body), { status: 201 }),
  );
  r.get(
    "/payments/:paymentId",
    guards.read,
    handler({ params: paymentParams }, async (a) => getPayment(a.ctx, scope(a), a.params.paymentId)),
  );
  r.patch(
    "/payments/:paymentId",
    guards.write,
    handler({ params: paymentParams, body: paymentPatch }, async (a) =>
      updatePayment(a.ctx, scope(a), a.params.paymentId, a.body),
    ),
  );
  r.post(
    "/payments/:paymentId/void",
    guards.write,
    handler({ params: paymentParams, body: voidInput }, async (a) =>
      voidPayment(a.ctx, scope(a), a.params.paymentId, a.body.reason),
    ),
  );
}

export const financeModule: ModuleRoutes = {
  name: "finance",
  site(r) {
    paymentRoutes(r, { read: requireSite("finance:read"), write: requireSite("finance:write") }, (a) => a.site.id);
    r.get(
      "/parties/:partyId/ledger",
      requireSite("finance:read"),
      handler({ params: partyParams, query: ledgerQuery }, async ({ params, query, ctx, site }) =>
        partyLedger(ctx, site, params.partyId, query),
      ),
    );
  },
  org(r) {
    paymentRoutes(r, { read: requireOrgAdmin, write: requireOrgAdmin }, () => null);
  },
};
