import type { Request, RequestHandler, Response } from "express";
import type { Model, FilterQuery, SortOrder } from "mongoose";
import { z, type ZodTypeAny } from "zod";
import { validationFailed, zodToFieldErrors } from "./errors";
import type { RequestContext, SiteContext } from "./context";
import { unauthenticated, notFound } from "./errors";
import { serialize } from "./db";

export const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Not a valid id");

type Schemas = { body?: ZodTypeAny; query?: ZodTypeAny; params?: ZodTypeAny };
type Out<S, K extends keyof Schemas> = S extends Record<K, infer Z extends ZodTypeAny> ? z.output<Z> : undefined;

export interface HandlerArgs<S extends Schemas> {
  body: Out<S, "body">;
  query: Out<S, "query">;
  params: Out<S, "params">;
  /** authenticated caller (throws if the route is public) */
  ctx: RequestContext;
  /** the site resolved by siteScope (throws on non-site routes) */
  site: SiteContext;
  req: Request;
  res: Response;
}

/**
 * Wraps a route: validates body/query/params with zod, then serialises the return value.
 * - return a value → JSON with `status` (default 200)
 * - return null/undefined → 204
 * - write to `res` yourself (streams) → nothing else happens
 */
export function handler<S extends Schemas>(
  schemas: S,
  fn: (args: HandlerArgs<S>) => Promise<unknown> | unknown,
  opts: { status?: number } = {},
): RequestHandler {
  return async (req, res) => {
    const parsed: Record<string, unknown> = {};
    for (const part of ["params", "query", "body"] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const r = schema.safeParse(req[part] ?? {});
      if (!r.success) throw validationFailed(zodToFieldErrors(r.error, part === "body" ? "" : part));
      parsed[part] = r.data;
    }
    const args = {
      body: parsed.body,
      query: parsed.query,
      params: parsed.params,
      req,
      res,
      get ctx() {
        if (!req.ctx) throw unauthenticated();
        return req.ctx;
      },
      get site() {
        if (!req.site) throw notFound("Site");
        return req.site;
      },
    } as HandlerArgs<S>;
    const result = await fn(args);
    if (res.headersSent) return;
    if (result === undefined || result === null) {
      res.status(204).end();
      return;
    }
    res.status(opts.status ?? 200).json(result);
  };
}

// ---------- Lists ----------
export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  sort: z.string().max(40).optional(),
});
export type ListQuery = z.infer<typeof listQuery>;

export interface List<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** Parses `sort` ("name" / "-createdAt") against an allow-list; falls back to `fallback`. */
export function parseSort(sort: string | undefined, allowed: string[], fallback: Record<string, SortOrder>) {
  if (!sort) return fallback;
  const desc = sort.startsWith("-");
  const field = desc ? sort.slice(1) : sort;
  if (!allowed.includes(field)) return fallback;
  return { [field]: desc ? -1 : 1, _id: 1 } as Record<string, SortOrder>;
}

export async function paginate<T, R = unknown>(
  model: Model<T>,
  filter: FilterQuery<T>,
  q: { page: number; pageSize: number },
  sort: Record<string, SortOrder>,
  map: (doc: Record<string, unknown>) => R = (d) => serialize<R>(d),
): Promise<List<R>> {
  const [docs, total] = await Promise.all([
    model
      .find(filter)
      .sort(sort)
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .lean(),
    model.countDocuments(filter),
  ]);
  return { items: (docs as Record<string, unknown>[]).map(map), page: q.page, pageSize: q.pageSize, total };
}

/** Escapes user text for a case-insensitive "contains" regex (no ReDoS / injection). */
export const containsRegex = (text: string) =>
  new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
