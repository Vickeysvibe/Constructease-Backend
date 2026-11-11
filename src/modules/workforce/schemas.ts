import { z } from "zod";
import { objectId } from "@/core/http";
import { isoDate } from "@/core/units";
import { ATTENDANCE_STATUSES, CHECKIN_TYPES } from "./models";

const shifts = z
  .number()
  .min(0)
  .max(3, "At most 3 shifts")
  .refine((v) => Number.isInteger(v * 2), "Shifts go in steps of 0.5");

export const attendanceEntryInput = z
  .object({
    labourId: objectId,
    status: z.enum(ATTENDANCE_STATUSES),
    shifts: shifts.optional(),
  })
  .strict()
  .transform((e, ctx) => {
    if (e.status === "absent") {
      if (e.shifts) ctx.addIssue({ code: "custom", path: ["shifts"], message: "Absent entries have 0 shifts" });
      return { ...e, shifts: 0 };
    }
    const s = e.shifts ?? 1;
    if (s <= 0) ctx.addIssue({ code: "custom", path: ["shifts"], message: "Present entries need at least 0.5 shifts" });
    return { ...e, shifts: s };
  });

export const attendanceSave = z
  .object({
    date: isoDate,
    entries: z.array(attendanceEntryInput).min(1, "Mark at least one labourer").max(500),
    /** engineer only: re-copy each labourer's current wage rate onto the day's entries */
    refreshRates: z.boolean().optional().default(false),
  })
  .strict()
  .superRefine((b, ctx) => {
    const seen = new Set<string>();
    b.entries.forEach((e, i) => {
      if (seen.has(e.labourId)) {
        ctx.addIssue({ code: "custom", path: ["entries", i, "labourId"], message: "This labourer is listed twice" });
      }
      seen.add(e.labourId);
    });
  });
export type AttendanceSave = z.infer<typeof attendanceSave>;

export const dateQuery = z.object({ date: isoDate.optional() });

export const checkinInput = z
  .object({
    type: z.enum(CHECKIN_TYPES),
    lat: z.number().min(-90, "Latitude must be between -90 and 90").max(90, "Latitude must be between -90 and 90"),
    lng: z.number().min(-180, "Longitude must be between -180 and 180").max(180, "Longitude must be between -180 and 180"),
    accuracyM: z.number().min(0).max(100_000).optional(),
  })
  .strict();
export type CheckinInput = z.infer<typeof checkinInput>;

export const checkinQuery = dateQuery.extend({ userId: objectId.optional() });
