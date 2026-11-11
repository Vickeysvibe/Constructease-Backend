/** LabourAttendances → AttendanceEntry, SupervisorAttendances → CheckinDay. */
import type { Types } from "mongoose";
import { AttendanceEntry, CheckinDay } from "@/modules/workforce/models";
import { alternate, businessDate, cleanShifts, pairCheckins, str, toPaise, type CheckEvent } from "../clean";
import { newId, type Migration, type SiteState } from "../context";

export async function migrateLabourAttendance(m: Migration) {
  const { legacy, report, tz } = m;
  const oldLabour = new Map(legacy.labours.map((l) => [String(l._id), l]));
  const taken = new Set<string>(); // `${siteHex}|${labourHex}|${date}` — one entry per site/day
  const presentOn = new Map<string, string>(); // `${orgHex}|${labourHex}|${date}` → site name of the kept entry

  for (const doc of legacy.labourAttendances) {
    const items = doc.attendance ?? [];
    report.count("labourAttendance", "read", items.length);
    const site = m.siteOf(doc.siteId);
    const date = businessDate(doc.date, tz, doc.createdAt);
    if (!site || !date) {
      for (const it of items) report.error("labourAttendance", `${String(doc._id)}:${String(it.labourId)}`, !site ? `site ${String(doc.siteId)} was not migrated` : "no date");
      continue;
    }
    const entries: Record<string, unknown>[] = [];
    const keys: { key: string; id: Types.ObjectId }[] = [];
    for (const it of items) {
      const key = `${String(doc._id)}:${String(it.labourId)}`;
      const party = m.parties.get(`labour:${String(it.labourId)}`);
      if (!party || party.org !== site.org) {
        report.error("labourAttendance", key, `labour ${String(it.labourId)} was not migrated`);
        continue;
      }
      const status = it.status === "present" ? "present" : it.status === "absent" ? "absent" : null;
      if (!status) {
        report.error("labourAttendance", key, `unknown status "${str(it.status)}"`);
        continue;
      }
      const siteKey = `${site.siteId.toHexString()}|${party.id.toHexString()}|${date}`;
      const dayKey = `${site.org.orgId.toHexString()}|${party.id.toHexString()}|${date}`;
      const already = Boolean(m.mapped("labour_attendance", key));
      if (!already && taken.has(siteKey)) {
        report.count("labourAttendance", "skipped");
        report.add("doubleBookings", { labour: party.name, date, site: site.name, oldAttendanceId: String(doc._id), message: "second entry for the same site and day; kept the first" });
        continue;
      }
      if (!already && status === "present" && presentOn.has(dayKey)) {
        report.count("labourAttendance", "skipped");
        report.add("doubleBookings", {
          labour: party.name,
          labourId: party.id.toHexString(),
          date,
          site: site.name,
          keptSite: presentOn.get(dayKey),
          oldAttendanceId: String(doc._id),
          message: "present on two sites the same day; kept the first",
        });
        continue;
      }
      taken.add(siteKey);
      if (status === "present") presentOn.set(dayKey, site.name);
      if (already) {
        report.count("labourAttendance", "alreadyMigrated");
        continue;
      }
      let shifts = 0;
      if (status === "present") {
        const s = cleanShifts(it.shift);
        shifts = s.shifts;
        if (s.changed) report.add("attendanceAdjustments", { key, labour: party.name, date, oldShift: it.shift ?? null, shifts });
      }
      // The old app never stored rate history: the labourer's current rate is the best snapshot we have.
      const rate = toPaise(oldLabour.get(String(it.labourId))?.wagesPerShift ?? (party.wageRatePaise ?? 0) / 100);
      const id = newId();
      entries.push({
        _id: id,
        orgId: site.org.orgId,
        siteId: site.siteId,
        labourId: party.id,
        date,
        status,
        shifts,
        wageRatePaise: Math.max(0, rate),
        wagePaise: Math.max(0, Math.round(shifts * rate)),
        markedBy: site.org.ownerId,
        createdAt: doc.createdAt,
      });
      keys.push({ key, id });
    }
    if (!entries.length) continue;
    const res = await m.unit("labourAttendance", String(doc._id), async (tx) => {
      await tx.create(AttendanceEntry, entries);
      for (const k of keys) tx.map("labour_attendance", k.key, k.id, site.org.orgId);
      tx.count("labourAttendance", "created", entries.length);
    });
    if (!res.ok) report.count("labourAttendance", "errors", entries.length - 1);
  }
}

type Event = CheckEvent & { lat: number; lng: number; address?: string };

export async function migrateCheckins(m: Migration) {
  const { legacy, report, tz } = m;
  const groups = new Map<string, { site: SiteState; userId: Types.ObjectId; date: string; raw: Event[]; keys: string[]; dropped: number }>();
  for (const doc of legacy.supervisorAttendances) {
    const site = m.siteOf(doc.siteId);
    for (const it of doc.attendance ?? []) {
      report.count("supervisorAttendance", "read");
      const key = `${String(doc._id)}:${String(it.supervisorId)}`;
      const userId = m.users.get(String(it.supervisorId));
      if (!site || !userId) {
        report.error("supervisorAttendance", key, !site ? `site ${String(doc.siteId)} was not migrated` : `supervisor ${String(it.supervisorId)} was not migrated`);
        continue;
      }
      const lat = Number(it.location?.latitude);
      const lng = Number(it.location?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        report.count("supervisorAttendance", "skipped");
        report.add("checkinAdjustments", { key, message: "no valid location; day skipped" });
        continue;
      }
      const { events, dropped } = pairCheckins(it.checkin ?? [], it.checkout ?? []);
      if (!events.length) {
        report.count("supervisorAttendance", "skipped");
        report.add("checkinAdjustments", { key, message: "no check-in times; day skipped" });
        continue;
      }
      const address = str(it.location?.address);
      const located = events.map((e) => ({
        ...e,
        lat,
        lng,
        ...(address && address !== "Location not available" && address !== "Unknown address" ? { address: address.slice(0, 500) } : {}),
      }));
      // The business day is the first check-in's day in the org timezone (the old `date` was a UTC day).
      const date = businessDate(events[0]!.at, tz)!;
      const gk = `${site.siteId.toHexString()}|${userId.toHexString()}|${date}`;
      const g = groups.get(gk) ?? { site, userId, date, raw: [], keys: [], dropped: 0 };
      g.raw.push(...located);
      g.keys.push(key);
      g.dropped += dropped;
      groups.set(gk, g);
    }
  }

  for (const g of groups.values()) {
    const done = g.keys.filter((k) => m.mapped("supervisor_checkin", k));
    if (done.length === g.keys.length) {
      report.count("supervisorAttendance", "alreadyMigrated", g.keys.length);
      continue;
    }
    if (done.length) {
      report.count("supervisorAttendance", "alreadyMigrated", done.length);
      report.count("supervisorAttendance", "skipped", g.keys.length - done.length);
      report.add("checkinAdjustments", { keys: g.keys, message: "day was partly migrated before; new pieces skipped" });
      continue;
    }
    const { events, dropped } = alternate(g.raw);
    const totalDropped = g.dropped + dropped;
    if (totalDropped) {
      report.add("checkinAdjustments", { keys: g.keys, date: g.date, droppedEvents: totalDropped, message: "unclosed or out-of-order check-ins dropped" });
    }
    const id = newId();
    const res = await m.unit("supervisorAttendance", g.keys[0], async (tx) => {
      await tx.create(CheckinDay, {
        _id: id,
        orgId: g.site.org.orgId,
        siteId: g.site.siteId,
        userId: g.userId,
        date: g.date,
        events,
      });
      for (const k of g.keys) tx.map("supervisor_checkin", k, id, g.site.org.orgId);
      tx.count("supervisorAttendance", "created");
      tx.count("supervisorAttendance", "merged", g.keys.length - 1);
    });
    if (!res.ok) report.count("supervisorAttendance", "errors", g.keys.length - 1);
  }
}
