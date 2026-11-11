import type { ClientSession, Types } from "mongoose";
import type { RequestContext } from "./context";

/** Lets modules react to lifecycle events without importing each other. */
type SiteCreatedHook = (
  ctx: Pick<RequestContext, "orgId" | "userId">,
  siteId: Types.ObjectId,
  session: ClientSession,
) => Promise<void>;

const siteCreated: SiteCreatedHook[] = [];
export const onSiteCreated = (fn: SiteCreatedHook) => void siteCreated.push(fn);
export const runSiteCreated: SiteCreatedHook = async (ctx, siteId, session) => {
  for (const fn of siteCreated) await fn(ctx, siteId, session);
};
