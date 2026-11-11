import type { RequestHandler } from "express";
import { Types } from "mongoose";
import { forbidden, invalidState, notFound, unauthenticated } from "./errors";
import { isOrgAdmin, type RequestContext, type SiteContext, type SiteRole } from "./context";
import { Membership, Site } from "@/modules/sites/models";

/**
 * Site-level permissions. Owners/admins act as `engineer` on every site.
 * Mirrors the matrix in docs/API.md — change both together.
 */
export const SITE_PERMISSIONS = {
  "site:read": ["engineer", "supervisor"],
  "site:manage": ["engineer"],
  "masters:write": ["engineer"],
  "labour:write": ["engineer", "supervisor"],
  "purchasing:write": ["engineer"],
  "receiving:write": ["engineer", "supervisor"],
  "stock:adjust": ["engineer"],
  "attendance:write": ["engineer", "supervisor"],
  "attendance:backdate": ["engineer"],
  "finance:read": ["engineer"],
  "finance:write": ["engineer"],
  "reports:read": ["engineer"],
  "worklog:write": ["engineer", "supervisor"],
  "notes:write": ["engineer", "supervisor"],
  "checkins:viewAll": ["engineer"],
} as const satisfies Record<string, readonly SiteRole[]>;

export type SitePermission = keyof typeof SITE_PERMISSIONS;

export const siteCan = (site: Pick<SiteContext, "role">, perm: SitePermission) =>
  (SITE_PERMISSIONS[perm] as readonly SiteRole[]).includes(site.role);

/** Resolves :siteId, checks the caller can see it, and sets req.site. Unknown or invisible sites are 404. */
export const siteScope: RequestHandler = async (req, _res, next) => {
  const ctx = req.ctx;
  if (!ctx) throw unauthenticated();
  const siteId = String(req.params.siteId ?? "");
  if (!siteId || !Types.ObjectId.isValid(siteId)) throw notFound("Site");
  const site = await Site.findOne({ _id: siteId, orgId: ctx.orgId }).lean();
  if (!site) throw notFound("Site");
  let role: SiteRole;
  if (isOrgAdmin(ctx)) {
    role = "engineer";
  } else {
    const m = await Membership.findOne({ orgId: ctx.orgId, siteId: site._id, userId: ctx.userId }).lean();
    if (!m) throw notFound("Site");
    role = m.role as SiteRole;
  }
  req.site = {
    id: site._id,
    name: site.name,
    status: site.status as SiteContext["status"],
    role,
    isOrgAdmin: isOrgAdmin(ctx),
  };
  next();
};

/** Guards a site route. Write permissions also refuse archived sites. */
export const requireSite =
  (perm: SitePermission): RequestHandler =>
  (req, _res, next) => {
    const site = req.site;
    if (!site) throw notFound("Site");
    if (!siteCan(site, perm)) throw forbidden();
    if (perm !== "site:read" && perm !== "finance:read" && perm !== "reports:read" && site.status === "archived") {
      throw invalidState("This site is archived. Restore it to make changes.");
    }
    next();
  };

/** Org-level guard: owner/admin only. */
export const requireOrgAdmin: RequestHandler = (req, _res, next) => {
  if (!req.ctx) throw unauthenticated();
  if (!isOrgAdmin(req.ctx)) throw forbidden();
  next();
};

/** Owner/admin, or engineer on at least one site (product catalogue, org-wide party search). */
export async function isEngineerAnywhere(ctx: RequestContext): Promise<boolean> {
  if (isOrgAdmin(ctx)) return true;
  const m = await Membership.exists({ orgId: ctx.orgId, userId: ctx.userId, role: "engineer" });
  return Boolean(m);
}

export const requireEngineerAnywhere: RequestHandler = async (req, _res, next) => {
  if (!req.ctx) throw unauthenticated();
  if (!(await isEngineerAnywhere(req.ctx))) throw forbidden();
  next();
};

/** Ids of the sites a user can see (all org sites for owner/admin). */
export async function visibleSiteIds(ctx: RequestContext): Promise<Types.ObjectId[]> {
  if (isOrgAdmin(ctx)) {
    const sites = await Site.find({ orgId: ctx.orgId }).select("_id").lean();
    return sites.map((s) => s._id);
  }
  const ms = await Membership.find({ orgId: ctx.orgId, userId: ctx.userId }).select("siteId").lean();
  return ms.map((m) => m.siteId);
}
