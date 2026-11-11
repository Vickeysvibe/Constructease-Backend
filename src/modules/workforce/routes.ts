import { handler } from "@/core/http";
import { requireSite } from "@/core/access";
import { registerJobHandler } from "@/core/jobs";
import { todayIn } from "@/core/units";
import type { ModuleRoutes } from "@/modules/registry";
import { attendanceSave, checkinInput, checkinQuery, dateQuery } from "./schemas";
import { attendanceSheet, GEOCODE_JOB, geocodeCheckin, listCheckins, recordCheckin, saveAttendance } from "./service";

registerJobHandler(GEOCODE_JOB, geocodeCheckin);

export const workforceModule: ModuleRoutes = {
  name: "workforce",
  site(r) {
    r.get(
      "/attendance",
      requireSite("site:read"),
      handler({ query: dateQuery }, async ({ query, ctx, site }) =>
        attendanceSheet(ctx, site, query.date ?? todayIn(ctx.tz)),
      ),
    );

    r.put(
      "/attendance",
      requireSite("attendance:write"),
      handler({ body: attendanceSave }, async ({ body, ctx, site }) => saveAttendance(ctx, site, body)),
    );

    r.post(
      "/checkins",
      requireSite("site:read"),
      handler({ body: checkinInput }, async ({ body, ctx, site }) => recordCheckin(ctx, site, body), { status: 201 }),
    );

    r.get(
      "/checkins",
      requireSite("site:read"),
      handler({ query: checkinQuery }, async ({ query, ctx, site }) => listCheckins(ctx, site, query)),
    );
  },
};
