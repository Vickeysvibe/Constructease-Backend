import crypto from "node:crypto";
import type { CookieOptions, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { config, isTest } from "./config";
import { unauthenticated, AppError } from "./errors";
import { Organization, Session, User } from "@/modules/identity/models";
import { DEFAULT_TZ } from "./units";

const ISSUER = "constructease";
const AUDIENCE = "constructease-web";
export const REFRESH_COOKIE = "ce_rt";
const COOKIE_PATH = "/api/v1/auth";

export const hashPassword = (plain: string) => bcrypt.hash(plain, isTest ? 4 : 12);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);
/** Legacy data may contain plaintext passwords (old Excel import bug). Only bcrypt hashes are accepted at login. */
export const isBcryptHash = (s: string) => /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(s);

interface AccessClaims {
  sub: string;
  org: string;
  sid: string;
}

export function signAccessToken(userId: Types.ObjectId, orgId: Types.ObjectId, sessionId: Types.ObjectId) {
  return jwt.sign({ org: orgId.toHexString(), sid: sessionId.toHexString() }, config.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    subject: userId.toHexString(),
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
  });
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAMESITE,
    path: COOKIE_PATH,
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  };
}

export async function createSession(
  user: { _id: Types.ObjectId; orgId: Types.ObjectId },
  meta: { userAgent?: string; ip?: string },
) {
  const token = newToken();
  const session = await Session.create({
    orgId: user.orgId,
    userId: user._id,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    userAgent: meta.userAgent?.slice(0, 300),
    ip: meta.ip,
  });
  return { session, cookieValue: `${session._id.toHexString()}.${token}` };
}

export function setRefreshCookie(res: Response, value: string) {
  res.cookie(REFRESH_COOKIE, value, cookieOptions());
}
export function clearRefreshCookie(res: Response) {
  const { maxAge: _maxAge, ...opts } = cookieOptions();
  res.clearCookie(REFRESH_COOKIE, opts);
}

/** Validates and rotates a refresh cookie. Reuse of a rotated token revokes the session. */
export async function rotateSession(cookieValue: string | undefined) {
  const [sid, token] = (cookieValue ?? "").split(".");
  if (!sid || !token || !Types.ObjectId.isValid(sid)) throw unauthenticated();
  const session = await Session.findOne({ _id: sid }).setOptions({ skipTenantGuard: true });
  if (!session || session.revokedAt || session.expiresAt < new Date()) throw unauthenticated();
  const hash = sha256(token);
  if (!timingSafeEqual(hash, session.tokenHash)) {
    if (session.prevTokenHash && timingSafeEqual(hash, session.prevTokenHash)) {
      session.revokedAt = new Date();
      session.revokedReason = "refresh token reuse";
      await session.save();
    }
    throw unauthenticated();
  }
  const next = newToken();
  session.prevTokenHash = session.tokenHash;
  session.tokenHash = sha256(next);
  await session.save();
  return { session, cookieValue: `${session._id.toHexString()}.${next}` };
}

export async function revokeSession(cookieValue: string | undefined) {
  const [sid] = (cookieValue ?? "").split(".");
  if (!sid || !Types.ObjectId.isValid(sid)) return;
  await Session.updateOne({ _id: sid }, { $set: { revokedAt: new Date(), revokedReason: "logout" } }).setOptions({
    skipTenantGuard: true,
  });
}

export async function revokeUserSessions(orgId: Types.ObjectId, userId: Types.ObjectId, exceptSessionId?: Types.ObjectId) {
  await Session.updateMany(
    { orgId, userId, revokedAt: { $exists: false }, ...(exceptSessionId ? { _id: { $ne: exceptSessionId } } : {}) },
    { $set: { revokedAt: new Date(), revokedReason: "revoked" } },
  );
}

function timingSafeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Authenticates the bearer token and loads the caller. Disabled users and revoked sessions are rejected immediately. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) throw unauthenticated();
  let claims: AccessClaims;
  try {
    claims = jwt.verify(token, config.JWT_ACCESS_SECRET, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
    }) as AccessClaims;
  } catch {
    throw unauthenticated("Your session has expired. Sign in again.");
  }
  if (!Types.ObjectId.isValid(claims.sub) || !Types.ObjectId.isValid(claims.org) || !Types.ObjectId.isValid(claims.sid)) {
    throw unauthenticated();
  }
  const orgId = new Types.ObjectId(claims.org);
  const [user, session, org] = await Promise.all([
    User.findOne({ _id: claims.sub, orgId }).lean(),
    Session.findOne({ _id: claims.sid, orgId }).select("revokedAt expiresAt").lean(),
    Organization.findById(orgId).select("timezone").lean(),
  ]);
  if (!user || user.status !== "active" || !session || session.revokedAt || !org) throw unauthenticated();
  req.ctx = {
    userId: user._id,
    orgId,
    orgRole: user.orgRole as "owner" | "admin" | "member",
    sessionId: session._id,
    tz: org.timezone ?? DEFAULT_TZ,
    userName: user.name,
  };
  next();
};

/** CSRF defence for cookie-authenticated endpoints: a custom header forces a CORS preflight. */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (req.get("X-CE-CSRF") !== "1") {
    throw new AppError(403, "FORBIDDEN", "Forbidden", "Missing X-CE-CSRF header.");
  }
  next();
};
