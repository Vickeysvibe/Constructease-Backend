import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "@/core/config";
import {
  clearRefreshCookie,
  createSession,
  hashPassword,
  isBcryptHash,
  REFRESH_COOKIE,
  requireAuth,
  requireCsrfHeader,
  revokeSession,
  revokeUserSessions,
  rotateSession,
  setRefreshCookie,
  signAccessToken,
  verifyPassword,
} from "@/core/auth";
import { handler, listQuery, objectId, paginate, parseSort, containsRegex } from "@/core/http";
import { AppError, conflict, notFound, validationFailed, invalidState } from "@/core/errors";
import { requireOrgAdmin, visibleSiteIds } from "@/core/access";
import { audit } from "@/core/records";
import { isOrgAdmin } from "@/core/context";
import { Organization, User, publicOrg, publicUser } from "./models";
import { Membership, Site } from "@/modules/sites/models";
import type { ModuleRoutes } from "@/modules/registry";
import type { Types } from "mongoose";

export const email = z.string().trim().toLowerCase().email("Enter a valid email address").max(200);
export const phone = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, "").replace(/^\+91/, ""))
  .pipe(z.string().regex(/^\d{10}$/, "Enter a 10-digit mobile number"));
export const password = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), "Use letters and numbers");

async function sessionPayload(userId: Types.ObjectId, orgId: Types.ObjectId, sessionId: Types.ObjectId) {
  const [user, org] = await Promise.all([User.findOne({ _id: userId, orgId }).lean(), Organization.findById(orgId).lean()]);
  if (!user || !org || user.status !== "active") throw new AppError(401, "UNAUTHENTICATED", "Not signed in");
  return {
    accessToken: signAccessToken(userId, orgId, sessionId),
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    user: publicUser(user),
    org: publicOrg(org),
  };
}

/** Public auth routes (mounted before requireAuth). */
export function authRouter() {
  const r = Router();
  const tooMany = (_req: unknown, _res: unknown, next: (err: AppError) => void) =>
    next(new AppError(429, "RATE_LIMITED", "Too many attempts", "Wait a minute and try again."));
  // Per email+IP: stops password guessing on one account without locking out colleagues behind the same office IP.
  const perAccount = rateLimit({
    windowMs: 60_000,
    limit: config.LOGIN_RATE_LIMIT_PER_MIN,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => `${req.ip}|${String((req.body as { email?: unknown })?.email ?? "").trim().toLowerCase()}`,
    handler: tooMany,
  });
  // Per IP: a ceiling against trying many accounts from one address.
  const perIp = rateLimit({
    windowMs: 60_000,
    limit: config.LOGIN_RATE_LIMIT_PER_MIN * 10,
    standardHeaders: false,
    legacyHeaders: false,
    handler: tooMany,
  });

  r.post(
    "/login",
    perIp,
    perAccount,
    handler({ body: z.object({ email, password: z.string().min(1).max(200) }) }, async ({ body, req, res }) => {
      const invalid = new AppError(401, "INVALID_CREDENTIALS", "Sign-in failed", "Email or password is incorrect.");
      const user = await User.findOne({ email: body.email })
        .select("+passwordHash")
        .setOptions({ skipTenantGuard: true });
      if (!user || user.status !== "active" || !isBcryptHash(user.passwordHash)) {
        // Constant-ish work so timing doesn't reveal which emails exist.
        await verifyPassword(body.password, "$2a$12$CwTycUXWue0Thq9StjUM0uJ8n6cXl1PHpGDl1F4mHn5r2E1JpWlq2");
        throw invalid;
      }
      if (!(await verifyPassword(body.password, user.passwordHash))) throw invalid;
      user.lastLoginAt = new Date();
      await user.save();
      const { session, cookieValue } = await createSession(user, { userAgent: req.get("user-agent"), ip: req.ip });
      setRefreshCookie(res, cookieValue);
      return sessionPayload(user._id, user.orgId, session._id);
    }),
  );

  r.post(
    "/refresh",
    requireCsrfHeader,
    handler({}, async ({ req, res }) => {
      try {
        const { session, cookieValue } = await rotateSession(req.cookies?.[REFRESH_COOKIE]);
        setRefreshCookie(res, cookieValue);
        return await sessionPayload(session.userId, session.orgId, session._id);
      } catch (err) {
        clearRefreshCookie(res);
        throw err;
      }
    }),
  );

  r.post(
    "/logout",
    requireCsrfHeader,
    handler({}, async ({ req, res }) => {
      await revokeSession(req.cookies?.[REFRESH_COOKIE]);
      clearRefreshCookie(res);
      return null;
    }),
  );

  r.post(
    "/change-password",
    requireAuth,
    handler(
      { body: z.object({ currentPassword: z.string().min(1), newPassword: password }) },
      async ({ body, ctx }) => {
        const user = await User.findOne({ _id: ctx.userId, orgId: ctx.orgId }).select("+passwordHash");
        if (!user) throw notFound("User");
        if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
          throw validationFailed([{ path: "currentPassword", message: "Current password is incorrect" }]);
        }
        user.passwordHash = await hashPassword(body.newPassword);
        await user.save();
        await revokeUserSessions(ctx.orgId, ctx.userId, ctx.sessionId);
        return null;
      },
    ),
  );
  return r;
}

const orgPatch = z
  .object({
    name: z.string().trim().min(1).max(120),
    logoUrl: z.string().trim().url().max(500).or(z.literal("")),
    description: z.string().trim().max(1000),
    address: z.string().trim().max(500),
    phone: z.string().trim().max(20),
    gstIn: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15}$/, "GSTIN has 15 letters and digits").or(z.literal("")),
    timezone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Unknown timezone"),
  })
  .partial();

const userCreate = z.object({
  name: z.string().trim().min(1).max(120),
  email,
  phone,
  password,
  orgRole: z.enum(["owner", "admin", "member"]).default("member"),
});
const userPatch = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone,
    orgRole: z.enum(["owner", "admin", "member"]),
    status: z.enum(["active", "disabled"]),
  })
  .partial();

async function assertNotLastOwner(orgId: Types.ObjectId, userId: Types.ObjectId) {
  const owners = await User.countDocuments({ orgId, orgRole: "owner", status: "active", _id: { $ne: userId } });
  if (owners === 0) throw invalidState("An organisation needs at least one active owner.");
}

export const identityModule: ModuleRoutes = {
  name: "identity",
  org(r) {
    r.get(
      "/me",
      handler({}, async ({ ctx }) => {
        const [user, org] = await Promise.all([
          User.findOne({ _id: ctx.userId, orgId: ctx.orgId }).lean(),
          Organization.findById(ctx.orgId).lean(),
        ]);
        if (!user || !org) throw notFound("User");
        const siteIds = await visibleSiteIds(ctx);
        const sites = await Site.find({ orgId: ctx.orgId, _id: { $in: siteIds } }).sort({ name: 1 }).lean();
        const memberships = isOrgAdmin(ctx)
          ? []
          : await Membership.find({ orgId: ctx.orgId, userId: ctx.userId }).lean();
        const roleOf = new Map(memberships.map((m) => [m.siteId.toHexString(), m.role]));
        return {
          user: publicUser(user),
          org: publicOrg(org),
          sites: sites.map((s) => ({
            id: s._id.toHexString(),
            name: s.name,
            status: s.status,
            role: isOrgAdmin(ctx) ? "engineer" : (roleOf.get(s._id.toHexString()) ?? "supervisor"),
          })),
        };
      }),
    );

    r.get(
      "/org",
      handler({}, async ({ ctx }) => {
        const org = await Organization.findById(ctx.orgId).lean();
        if (!org) throw notFound("Organisation");
        return publicOrg(org);
      }),
    );
    r.patch(
      "/org",
      requireOrgAdmin,
      handler({ body: orgPatch }, async ({ body, ctx }) => {
        const org = await Organization.findByIdAndUpdate(ctx.orgId, { $set: body }, { new: true, runValidators: true }).lean();
        if (!org) throw notFound("Organisation");
        return publicOrg(org);
      }),
    );

    r.get(
      "/users",
      requireOrgAdmin,
      handler(
        { query: listQuery.extend({ status: z.enum(["active", "disabled"]).optional() }) },
        async ({ query, ctx }) => {
          const filter: Record<string, unknown> = { orgId: ctx.orgId };
          if (query.status) filter.status = query.status;
          if (query.q) filter.$or = [{ name: containsRegex(query.q) }, { email: containsRegex(query.q) }];
          return paginate(User, filter, query, parseSort(query.sort, ["name", "email", "createdAt"], { name: 1 }), (u) =>
            publicUser(u as never),
          );
        },
      ),
    );
    r.post(
      "/users",
      requireOrgAdmin,
      handler(
        { body: userCreate },
        async ({ body, ctx }) => {
          if (body.orgRole === "owner" && ctx.orgRole !== "owner") throw invalidState("Only an owner can add owners.");
          if (await User.exists({ email: body.email }).setOptions({ skipTenantGuard: true })) {
            throw conflict("A user with this email already exists.", [{ path: "email", message: "Email is already in use" }]);
          }
          const { password: pw, ...rest } = body;
          const user = await User.create({ ...rest, orgId: ctx.orgId, passwordHash: await hashPassword(pw) });
          await audit(ctx, { action: "user.create", entity: "User", entityId: user._id, data: { orgRole: user.orgRole } });
          return publicUser(user.toObject());
        },
        { status: 201 },
      ),
    );
    r.patch(
      "/users/:userId",
      requireOrgAdmin,
      handler({ params: z.object({ userId: objectId }), body: userPatch }, async ({ params, body, ctx }) => {
        const user = await User.findOne({ _id: params.userId, orgId: ctx.orgId });
        if (!user) throw notFound("User");
        const demoting = body.orgRole && body.orgRole !== "owner" && user.orgRole === "owner";
        const disabling = body.status === "disabled" && user.status === "active";
        if ((demoting || disabling) && user.orgRole === "owner") await assertNotLastOwner(ctx.orgId, user._id);
        if ((body.orgRole === "owner" || user.orgRole === "owner") && ctx.orgRole !== "owner") {
          throw invalidState("Only an owner can change an owner's role.");
        }
        Object.assign(user, body);
        await user.save();
        if (disabling) await revokeUserSessions(ctx.orgId, user._id);
        await audit(ctx, { action: "user.update", entity: "User", entityId: user._id, data: body });
        return publicUser(user.toObject());
      }),
    );
    r.post(
      "/users/:userId/reset-password",
      requireOrgAdmin,
      handler(
        { params: z.object({ userId: objectId }), body: z.object({ newPassword: password }) },
        async ({ params, body, ctx }) => {
          const user = await User.findOne({ _id: params.userId, orgId: ctx.orgId });
          if (!user) throw notFound("User");
          user.passwordHash = await hashPassword(body.newPassword);
          await user.save();
          await revokeUserSessions(ctx.orgId, user._id);
          await audit(ctx, { action: "user.resetPassword", entity: "User", entityId: user._id });
          return null;
        },
      ),
    );
  },
};
