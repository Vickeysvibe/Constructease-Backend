import type { Types } from "mongoose";

export type OrgRole = "owner" | "admin" | "member";
export type SiteRole = "engineer" | "supervisor";

/** Who is calling. Set by requireAuth. */
export interface RequestContext {
  userId: Types.ObjectId;
  orgId: Types.ObjectId;
  orgRole: OrgRole;
  sessionId: Types.ObjectId;
  tz: string;
  userName: string;
}

/** Which site the request is about and the caller's effective role on it. Set by siteScope. */
export interface SiteContext {
  id: Types.ObjectId;
  name: string;
  status: "active" | "archived";
  /** owner/admin act as engineer on every site */
  role: SiteRole;
  isOrgAdmin: boolean;
}

declare module "express-serve-static-core" {
  interface Request {
    ctx?: RequestContext;
    site?: SiteContext;
  }
}

export const isOrgAdmin = (ctx: Pick<RequestContext, "orgRole">) =>
  ctx.orgRole === "owner" || ctx.orgRole === "admin";

/** Scope filter for org-owned collections. */
export const orgScope = (ctx: Pick<RequestContext, "orgId">) => ({ orgId: ctx.orgId });
/** Scope filter for site-owned collections. */
export const siteScopeFilter = (ctx: Pick<RequestContext, "orgId">, site: Pick<SiteContext, "id">) => ({
  orgId: ctx.orgId,
  siteId: site.id,
});
