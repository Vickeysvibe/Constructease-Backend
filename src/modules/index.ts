import type { ModuleRoutes } from "./registry";
import { identityModule } from "./identity/routes";
import { sitesModule } from "./sites/routes";
import { partiesModule } from "./parties/routes";
import { productsModule } from "./products/routes";
import { importsModule } from "./imports/routes";
import { filesModule } from "./files/routes";
import { purchasingModule } from "./purchasing/routes";
import { inventoryModule } from "./inventory/routes";
import { workforceModule } from "./workforce/routes";
import { financeModule } from "./finance/routes";
import { worklogModule } from "./worklog/routes";
import { notesModule } from "./notes/routes";
import { dashboardModule } from "./dashboard/routes";
import { reportsModule } from "./reports/routes";

/** Mounted in this order. Importing a module also registers its job handlers and hooks. */
export const modules: ModuleRoutes[] = [
  identityModule,
  sitesModule,
  partiesModule,
  productsModule,
  importsModule,
  filesModule,
  purchasingModule,
  inventoryModule,
  workforceModule,
  financeModule,
  worklogModule,
  notesModule,
  dashboardModule,
  reportsModule,
];
