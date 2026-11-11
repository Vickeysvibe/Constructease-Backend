/** Pure value-cleaning helpers for the legacy migration (no I/O; unit-testable). */
import { dateOfInstant } from "@/core/units";

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
export const PLACEHOLDER_PHONE = "0000000000";

export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** Trims and cuts a string to `max` characters; `cut` tells the caller something was lost. */
export function clip(v: unknown, max: number): { value: string; cut: boolean } {
  const s = str(v);
  return s.length > max ? { value: s.slice(0, max), cut: true } : { value: s, cut: false };
}

/** Digits only; drops a +91 / 0 prefix. `valid` = exactly 10 digits. */
export function cleanPhone(raw: unknown): { digits: string; valid: boolean } {
  let d = str(raw).replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return { digits: d, valid: /^\d{10}$/.test(d) };
}

/** Old Client.panGstNo held either a GSTIN or a PAN (or junk). */
export function classifyTaxId(raw: unknown): { gstIn?: string; pan?: string; dropped?: string } {
  const s = str(raw).toUpperCase().replace(/\s+/g, "");
  if (!s) return {};
  if (GSTIN_RE.test(s)) return { gstIn: s };
  if (PAN_RE.test(s)) return { pan: s };
  return { dropped: str(raw) };
}

export const toPaise = (rupees: unknown): number => {
  const n = Number(rupees);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
export const toMilliSafe = (qty: unknown): number => {
  const n = Number(qty);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
};
/** Old tax was a percentage (18) → basis points (1800). */
export const percentToBp = (pct: unknown): number | undefined => {
  const n = Number(pct);
  if (pct == null || pct === "" || !Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return Math.round(n * 100);
};

/** Legacy dates are BSON dates, but some were written as strings/numbers. */
export function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Business date (YYYY-MM-DD) of a legacy instant in the org timezone; falls back to `fallback`. */
export function businessDate(v: unknown, tz: string, fallback?: unknown): string | null {
  const d = toDate(v) ?? toDate(fallback);
  return d ? dateOfInstant(d, tz) : null;
}

/** Present → shifts rounded to 0.5 and clamped to [0.5, 3]; `changed` when the old value wasn't representable. */
export function cleanShifts(raw: unknown): { shifts: number; changed: boolean } {
  const n = raw == null || raw === "" ? 1 : Number(raw);
  if (!Number.isFinite(n)) return { shifts: 1, changed: true };
  const s = Math.min(3, Math.max(0.5, Math.round(n * 2) / 2));
  return { shifts: s, changed: s !== n };
}

/**
 * Old check-ins: every check-in pushed `now` onto BOTH checkin[] and checkout[]; a check-out overwrote the
 * last checkout. So checkout[i] === checkin[i] means "never checked out" (bogus value).
 * Returns alternating in/out events sorted by time; an unclosed check-in followed by another check-in is dropped.
 */
export function pairCheckins(checkin: unknown[] = [], checkout: unknown[] = []) {
  const raw: CheckEvent[] = [];
  checkin.forEach((c, i) => {
    const at = toDate(c);
    if (!at) return;
    raw.push({ type: "in", at });
    const out = toDate(checkout[i]);
    if (out && out.getTime() > at.getTime()) raw.push({ type: "out", at: out });
  });
  return alternate(raw);
}

export interface CheckEvent {
  type: "in" | "out";
  at: Date;
}

/** Sorts events by time and enforces in/out alternation (an unclosed check-in followed by another one is dropped). */
export function alternate<T extends CheckEvent>(raw: T[]): { events: T[]; dropped: number } {
  const sorted = [...raw].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.type === "in" ? -1 : 1));
  const events: T[] = [];
  let dropped = 0;
  for (const e of sorted) {
    const last = events[events.length - 1];
    if (e.type === "in" && last?.type === "in") {
      events.pop(); // never closed: keep the later check-in
      dropped++;
    } else if (e.type === "out" && last?.type !== "in") {
      dropped++;
      continue; // an out without an open in
    }
    events.push(e);
  }
  return { events, dropped };
}

/** Maps the old free-text "paymentAs" (cash / UPI / cheque / NEFT …) to a payment method. */
export function paymentMethod(raw: unknown): "cash" | "bank" | "upi" | "cheque" | "other" | undefined {
  const s = str(raw).toLowerCase();
  if (!s) return undefined;
  if (s.includes("cash")) return "cash";
  if (/upi|gpay|google ?pay|phonepe|paytm/.test(s)) return "upi";
  if (/cheque|check|chq|dd/.test(s)) return "cheque";
  if (/bank|neft|rtgs|imps|transfer|online|account/.test(s)) return "bank";
  return "other";
}

export const isHttpUrl = (s: string) => /^https?:\/\/\S+$/i.test(s);
