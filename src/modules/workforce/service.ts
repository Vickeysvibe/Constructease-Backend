import { Types } from "mongoose";
import { config } from "@/core/config";
import { withTransaction } from "@/core/db";
import { siteCan } from "@/core/access";
import { conflict, forbidden, invalidState, validationFailed, type FieldError } from "@/core/errors";
import type { RequestContext, SiteContext } from "@/core/context";
import { enqueue, type JobContext } from "@/core/jobs";
import { logger } from "@/core/logger";
import { audit } from "@/core/records";
import { addDays, todayIn } from "@/core/units";
import { User } from "@/modules/identity/models";
import { Party, type PartyDoc } from "@/modules/parties/models";
import { Site } from "@/modules/sites/models";
import {
  AttendanceEntry,
  CheckinDay,
  type AttendanceEntryDoc,
  type CheckinDayDoc,
  type CheckinEventDoc,
} from "./models";
import type { AttendanceSave, CheckinInput } from "./schemas";

type Ctx = Pick<RequestContext, "orgId" | "userId" | "tz">;
const hex = (id: Types.ObjectId) => id.toHexString();
const isDuplicateKey = (err: unknown) => (err as { code?: number })?.code === 11000;

// ======================= Attendance =======================

/** Whether this caller may write attendance for `date`: never the future; supervisors only today and yesterday. */
export function canEditAttendance(site: SiteContext, date: string, today: string): boolean {
  if (site.status === "archived" || !siteCan(site, "attendance:write") || date > today) return false;
  return siteCan(site, "attendance:backdate") || date >= addDays(today, -1);
}

export const wageOf = (shifts: number, ratePaise: number) => Math.round(shifts * ratePaise);

export async function attendanceSheet(ctx: Ctx, site: SiteContext, date: string) {
  const [labour, entries] = await Promise.all([
    Party.find({ orgId: ctx.orgId, siteIds: site.id, kind: "labour", status: "active" }).lean<PartyDoc[]>(),
    AttendanceEntry.find({ orgId: ctx.orgId, siteId: site.id, date }).lean<AttendanceEntryDoc[]>(),
  ]);
  // Entries for labour since detached or archived stay visible so the day's totals never hide wages.
  const known = new Set(labour.map((p) => hex(p._id)));
  const orphanIds = entries.map((e) => e.labourId).filter((id) => !known.has(hex(id)));
  if (orphanIds.length) {
    labour.push(...(await Party.find({ orgId: ctx.orgId, _id: { $in: orphanIds } }).lean<PartyDoc[]>()));
  }
  labour.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

  const byLabour = new Map(entries.map((e) => [hex(e.labourId), e]));
  const summary = { present: 0, absent: 0, unmarked: 0, shifts: 0, wagesPaise: 0 };
  const categories = new Map<string, { category: string; present: number; shifts: number }>();

  const rows = labour.map((p) => {
    const e = byLabour.get(hex(p._id));
    const category = p.category ?? "Uncategorised";
    const cat = categories.get(category) ?? { category, present: 0, shifts: 0 };
    categories.set(category, cat);
    if (!e) summary.unmarked += 1;
    else if (e.status === "present") {
      summary.present += 1;
      summary.shifts += e.shifts;
      summary.wagesPaise += e.wagePaise;
      cat.present += 1;
      cat.shifts += e.shifts;
    } else summary.absent += 1;
    return {
      labourId: hex(p._id),
      name: p.name,
      phone: p.phone,
      category: p.category ?? undefined,
      subCategory: p.subCategory ?? undefined,
      wageRatePaise: p.wageRatePaise ?? 0,
      entry: e
        ? { id: hex(e._id), status: e.status, shifts: e.shifts, wageRatePaise: e.wageRatePaise, wagePaise: e.wagePaise }
        : null,
    };
  });

  return {
    date,
    editable: canEditAttendance(site, date, todayIn(ctx.tz)),
    rows,
    summary: {
      ...summary,
      byCategory: [...categories.values()].sort((a, b) => a.category.localeCompare(b.category)),
    },
  };
}

export async function saveAttendance(ctx: Ctx, site: SiteContext, body: AttendanceSave) {
  const today = todayIn(ctx.tz);
  if (body.date > today) {
    throw validationFailed([{ path: "date", message: "Attendance can't be marked for a future date" }]);
  }
  if (!canEditAttendance(site, body.date, today)) {
    throw forbidden("Supervisors can mark attendance only for today and yesterday.");
  }
  if (body.refreshRates && site.role !== "engineer") {
    throw forbidden("Only engineers can refresh wage rates.");
  }

  const ids = body.entries.map((e) => new Types.ObjectId(e.labourId));
  const labour = await Party.find({
    orgId: ctx.orgId,
    _id: { $in: ids },
    kind: "labour",
    siteIds: site.id,
    status: "active",
  }).lean<PartyDoc[]>();
  const labourById = new Map(labour.map((p) => [hex(p._id), p]));
  const missing: FieldError[] = body.entries.flatMap((e, i) =>
    labourById.has(e.labourId) ? [] : [{ path: `entries.${i}.labourId`, message: "Not an active labourer on this site" }],
  );
  if (missing.length) throw validationFailed(missing);

  // A labourer can be present on only one site per day.
  const presentIds = body.entries.filter((e) => e.status === "present").map((e) => new Types.ObjectId(e.labourId));
  const elsewhere = presentIds.length
    ? await AttendanceEntry.find({
        orgId: ctx.orgId,
        labourId: { $in: presentIds },
        date: body.date,
        status: "present",
        siteId: { $ne: site.id },
      }).lean<AttendanceEntryDoc[]>()
    : [];
  if (elsewhere.length) {
    const sites = await Site.find({ orgId: ctx.orgId, _id: { $in: elsewhere.map((e) => e.siteId) } })
      .select("name")
      .lean();
    const siteName = new Map(sites.map((s) => [hex(s._id), s.name]));
    const otherSite = new Map(elsewhere.map((e) => [hex(e.labourId), siteName.get(hex(e.siteId)) ?? "another site"]));
    const errors = body.entries.flatMap((e, i) =>
      e.status === "present" && otherSite.has(e.labourId)
        ? [{ path: `entries.${i}.labourId`, message: `Already marked present at ${otherSite.get(e.labourId)} on ${body.date}` }]
        : [],
    );
    throw conflict("Some labourers are already marked present on another site that day.", errors);
  }

  const existing = await AttendanceEntry.find({ orgId: ctx.orgId, siteId: site.id, date: body.date, labourId: { $in: ids } })
    .lean<AttendanceEntryDoc[]>();
  const existingByLabour = new Map(existing.map((e) => [hex(e.labourId), e]));

  try {
    await withTransaction(async (session) => {
      for (const e of body.entries) {
        const prev = existingByLabour.get(e.labourId);
        // Snapshot the rate on first creation; keep it on later edits unless explicitly refreshed.
        const rate = prev && !body.refreshRates ? prev.wageRatePaise : (labourById.get(e.labourId)!.wageRatePaise ?? 0);
        await AttendanceEntry.updateOne(
          { orgId: ctx.orgId, siteId: site.id, labourId: new Types.ObjectId(e.labourId), date: body.date },
          {
            $set: {
              status: e.status,
              shifts: e.shifts,
              wageRatePaise: rate,
              wagePaise: wageOf(e.shifts, rate),
              markedBy: ctx.userId,
            },
          },
          { upsert: true, session, runValidators: true },
        );
      }
      await audit(
        ctx,
        {
          action: "attendance.save",
          entity: "Site",
          entityId: site.id,
          siteId: site.id,
          data: { date: body.date, entries: body.entries.length, refreshRates: body.refreshRates },
        },
        session,
      );
    });
  } catch (err) {
    // Lost a race with another site marking the same labourer present.
    if (isDuplicateKey(err)) throw conflict("Some labourers were just marked present on another site that day. Reload and try again.");
    throw err;
  }
  return attendanceSheet(ctx, site, body.date);
}

// ======================= Check-ins =======================

export function checkinTotals(events: Pick<CheckinEventDoc, "type" | "at">[]) {
  let openAt: Date | undefined;
  let workedMs = 0;
  let firstIn: Date | undefined;
  let lastOut: Date | undefined;
  for (const ev of events) {
    if (ev.type === "in") {
      openAt = ev.at;
      firstIn ??= ev.at;
    } else {
      if (openAt) workedMs += ev.at.getTime() - openAt.getTime();
      openAt = undefined;
      lastOut = ev.at;
    }
  }
  return { firstIn, lastOut, workedMinutes: Math.floor(workedMs / 60_000) };
}

export function publicCheckinDay(d: CheckinDayDoc, user: { id: string; name: string }) {
  const totals = checkinTotals(d.events);
  return {
    id: hex(d._id),
    user,
    date: d.date,
    events: d.events.map((e) => ({
      type: e.type,
      at: e.at.toISOString(),
      lat: e.lat,
      lng: e.lng,
      accuracyM: e.accuracyM ?? undefined,
      address: e.address ?? undefined,
    })),
    firstIn: totals.firstIn?.toISOString(),
    lastOut: totals.lastOut?.toISOString(),
    workedMinutes: totals.workedMinutes,
  };
}

export async function recordCheckin(ctx: Ctx & Pick<RequestContext, "userName">, site: SiteContext, input: CheckinInput) {
  if (site.status === "archived") throw invalidState("This site is archived. Restore it to make changes.");
  const scope = { orgId: ctx.orgId, siteId: site.id, userId: ctx.userId };
  const today = todayIn(ctx.tz);
  let day = await CheckinDay.findOne({ ...scope, date: today }).lean<CheckinDayDoc>();
  // A night shift that started yesterday is closed on yesterday's record.
  if (input.type === "out" && !day?.events.length) {
    const prev = await CheckinDay.findOne({ ...scope, date: addDays(today, -1) }).lean<CheckinDayDoc>();
    if (prev?.events.at(-1)?.type === "in") day = prev;
  }
  const last = day?.events.at(-1)?.type;
  if (input.type === "in" && last === "in") throw conflict("You are already checked in. Check out first.");
  if (input.type === "out" && last !== "in") throw conflict("You are not checked in.");

  const count = day?.events.length ?? 0;
  const event = { _id: new Types.ObjectId(), type: input.type, at: new Date(), lat: input.lat, lng: input.lng, accuracyM: input.accuracyM };
  // `$size` guards against a concurrent check-in: a lost race finds no document (409 below) or hits the unique index (409).
  const saved = await CheckinDay.findOneAndUpdate(
    { ...scope, date: day?.date ?? today, events: { $size: count } },
    { $push: { events: event } },
    { upsert: count === 0, new: true, runValidators: true },
  ).lean<CheckinDayDoc>();
  if (!saved) throw conflict("Your check-ins changed in the meantime. Reload and try again.");

  if (config.GEOCODER_URL) {
    // Address lookup is best-effort and must never fail the check-in.
    await enqueue(ctx, GEOCODE_JOB, { checkinId: hex(saved._id), eventId: hex(event._id), lat: input.lat, lng: input.lng }).catch(
      (err: unknown) => logger.warn({ err }, "could not enqueue geocoding"),
    );
  }
  return publicCheckinDay(saved, { id: hex(ctx.userId), name: ctx.userName });
}

export async function listCheckins(ctx: Ctx, site: SiteContext, query: { date?: string; userId?: string }) {
  const date = query.date ?? todayIn(ctx.tz);
  let userId: Types.ObjectId | undefined;
  if (siteCan(site, "checkins:viewAll")) {
    userId = query.userId ? new Types.ObjectId(query.userId) : undefined;
  } else {
    if (query.userId && query.userId !== hex(ctx.userId)) throw forbidden("You can only see your own check-ins.");
    userId = ctx.userId;
  }
  const days = await CheckinDay.find({ orgId: ctx.orgId, siteId: site.id, date, ...(userId ? { userId } : {}) })
    .lean<CheckinDayDoc[]>();
  const users = await User.find({ orgId: ctx.orgId, _id: { $in: days.map((d) => d.userId) } }).select("name").lean();
  const names = new Map(users.map((u) => [hex(u._id), u.name]));
  const firstAt = (d: CheckinDayDoc) => d.events[0]?.at.getTime() ?? 0;
  return {
    items: days
      .sort((a, b) => firstAt(a) - firstAt(b))
      .map((d) => publicCheckinDay(d, { id: hex(d.userId), name: names.get(hex(d.userId)) ?? "" })),
  };
}

// ======================= Geocoding job =======================

export const GEOCODE_JOB = "workforce.geocode";

/** Reverse-geocodes one check-in event (Nominatim-compatible API) and stores the address. */
export async function geocodeCheckin(job: JobContext) {
  const base = config.GEOCODER_URL;
  if (!base) return;
  const { checkinId, eventId, lat, lng } = job.payload as { checkinId: string; eventId: string; lat: number; lng: number };
  const url = `${base}${base.includes("?") ? "&" : "?"}format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": config.GEOCODER_USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Geocoder responded with ${res.status}`);
  const body = (await res.json()) as { display_name?: unknown };
  const address = typeof body.display_name === "string" ? body.display_name.trim().slice(0, 300) : "";
  if (!address) return;
  await CheckinDay.updateOne(
    { _id: new Types.ObjectId(checkinId), orgId: job.orgId, "events._id": new Types.ObjectId(eventId) },
    { $set: { "events.$.address": address } },
  );
}
