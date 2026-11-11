import type { Router } from "express";

/**
 * Each module exposes its routes here. `org` routes mount on /api/v1 (authenticated);
 * `site` routes mount on /api/v1/sites/:siteId after siteScope has resolved req.site.
 * Paths are written in full relative to those roots, e.g. site: r.get("/purchase-orders", …).
 */
export interface ModuleRoutes {
  name: string;
  org?: (r: Router) => void;
  site?: (r: Router) => void;
}
