import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import customParseFormat from "dayjs/plugin/customParseFormat";
import { z } from "zod";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export { dayjs };

export const DEFAULT_TZ = "Asia/Kolkata";

// ---------- Money: integer paise ----------
export const MAX_PAISE = 1_000_000_000_000; // ₹1,000 crore
export const paise = z.number().int("Must be a whole number of paise").min(0).max(MAX_PAISE);
export const positivePaise = paise.refine((v) => v > 0, "Must be greater than 0");
export const taxRateBp = z.number().int().min(0).max(10_000);

// ---------- Quantity: API decimals (≤3 dp) ↔ stored integer thousandths ----------
export const toMilli = (qty: number): number => Math.round(qty * 1000);
export const fromMilli = (milli: number): number => milli / 1000;

const hasAtMost3Decimals = (v: number) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6;
export const qty = z
  .number()
  .finite()
  .refine(hasAtMost3Decimals, "At most 3 decimal places")
  .refine((v) => Math.abs(v) <= 1_000_000_000, "Quantity is too large");
export const positiveQty = qty.refine((v) => v > 0, "Must be greater than 0");

/** amount for qty (thousandths) × unit price (paise), rounded half-up to the paisa */
export const lineAmountPaise = (qtyMilli: number, unitPricePaise: number): number =>
  Math.round((qtyMilli * unitPricePaise) / 1000);
export const taxPaise = (amountPaise: number, rateBp: number): number =>
  Math.round((amountPaise * rateBp) / 10_000);

export function priceLine(qtyMilli: number, unitPricePaise: number, rateBp: number) {
  const amountPaise = lineAmountPaise(qtyMilli, unitPricePaise);
  const tax = taxPaise(amountPaise, rateBp);
  return { amountPaise, taxPaise: tax, totalPaise: amountPaise + tax };
}

// ---------- Business dates: 'YYYY-MM-DD' in the org's timezone ----------
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((s) => dayjs(s, "YYYY-MM-DD", true).isValid(), "Not a real calendar date");

export const todayIn = (tz: string = DEFAULT_TZ): string => dayjs().tz(tz).format("YYYY-MM-DD");
export const addDays = (date: string, days: number): string =>
  dayjs(date, "YYYY-MM-DD").add(days, "day").format("YYYY-MM-DD");
export const monthOf = (date: string): string => date.slice(0, 7);
export const daysBetween = (from: string, to: string): number =>
  dayjs(to, "YYYY-MM-DD").diff(dayjs(from, "YYYY-MM-DD"), "day");
export const eachDay = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};
/** business date of an instant in a timezone */
export const dateOfInstant = (at: Date, tz: string = DEFAULT_TZ): string =>
  dayjs(at).tz(tz).format("YYYY-MM-DD");

/** Inclusive date range with a sane maximum span. */
export const dateRange = (maxDays = 366) =>
  z
    .object({ from: isoDate, to: isoDate })
    .refine((r) => r.from <= r.to, { message: "'from' must be on or before 'to'", path: ["to"] })
    .refine((r) => daysBetween(r.from, r.to) < maxDays, {
      message: `Range can be at most ${maxDays} days`,
      path: ["to"],
    });
