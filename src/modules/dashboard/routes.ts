import { requireSite } from "@/core/access";
import { handler } from "@/core/http";
import type { ModuleRoutes } from "@/modules/registry";
import { orgDashboard, siteDashboard } from "./service";

export const dashboardModule: ModuleRoutes = {
  name: "dashboard",
  site(r) {
    r.get(
      "/dashboard",
      requireSite("site:read"),
      handler({}, async ({ ctx, site }) => siteDashboard(ctx, site)),
    );
  },
  org(r) {
    r.get(
      "/dashboard",
      handler({}, async ({ ctx }) => orgDashboard(ctx)),
    );
  },
};
