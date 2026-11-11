import type { ErrorRequestHandler, RequestHandler } from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";
import { logger } from "./logger";

export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "INVALID_CREDENTIALS"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATE"
  | "INSUFFICIENT_STOCK"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL";

export interface FieldError {
  path: string;
  message: string;
}

/** Every expected failure is an AppError; the error handler renders it as application/problem+json. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: FieldError[],
    /** extra problem members, e.g. { result } for a rejected import */
    readonly extra?: Record<string, unknown>,
  ) {
    super(detail ?? title);
  }
}

export const badRequest = (detail?: string, errors?: FieldError[]) =>
  new AppError(400, "BAD_REQUEST", "Bad request", detail, errors);
export const validationFailed = (errors: FieldError[], detail = "Some fields are invalid.") =>
  new AppError(422, "VALIDATION_FAILED", "Validation failed", detail, errors);
export const unauthenticated = (detail = "Sign in to continue.") =>
  new AppError(401, "UNAUTHENTICATED", "Not signed in", detail);
export const forbidden = (detail = "You don't have permission to do this.") =>
  new AppError(403, "FORBIDDEN", "Forbidden", detail);
export const notFound = (entity = "Resource") =>
  new AppError(404, "NOT_FOUND", "Not found", `${entity} not found.`);
export const conflict = (detail: string, errors?: FieldError[]) =>
  new AppError(409, "CONFLICT", "Conflict", detail, errors);
export const invalidState = (detail: string, errors?: FieldError[]) =>
  new AppError(409, "INVALID_STATE", "Not allowed in the current state", detail, errors);
export const insufficientStock = (detail: string, errors?: FieldError[]) =>
  new AppError(409, "INSUFFICIENT_STOCK", "Not enough stock", detail, errors);

export const zodToFieldErrors = (err: ZodError, prefix = ""): FieldError[] =>
  err.issues.map((i) => ({
    path: [prefix, ...i.path].filter((p) => p !== "").join("."),
    message: i.message,
  }));

function toProblem(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return validationFailed(zodToFieldErrors(err));
  if (err instanceof mongoose.Error.ValidationError) {
    return validationFailed(
      Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })),
    );
  }
  if (err instanceof mongoose.Error.CastError) return notFound();
  const anyErr = err as { code?: unknown; type?: string; status?: number; keyValue?: object };
  if (anyErr?.code === 11000) {
    const fields = Object.keys(anyErr.keyValue ?? {}).filter((k) => k !== "orgId");
    return conflict(`A record with the same ${fields.join(", ") || "values"} already exists.`);
  }
  if (anyErr?.type === "entity.parse.failed") return badRequest("Request body is not valid JSON.");
  if (anyErr?.type === "entity.too.large" || anyErr?.code === "LIMIT_FILE_SIZE") {
    return new AppError(413, "PAYLOAD_TOO_LARGE", "Payload too large", "The upload is larger than allowed.");
  }
  return new AppError(500, "INTERNAL", "Something went wrong", "An unexpected error occurred.");
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const problem = toProblem(err);
  if (problem.status >= 500) {
    logger.error({ err, method: req.method, url: req.originalUrl }, "unhandled error");
  }
  if (res.headersSent) return;
  res
    .status(problem.status)
    .type("application/problem+json")
    .json({
      type: `https://constructease.app/problems/${problem.code.toLowerCase().replace(/_/g, "-")}`,
      title: problem.title,
      status: problem.status,
      code: problem.code,
      ...(problem.detail ? { detail: problem.detail } : {}),
      ...(problem.errors?.length ? { errors: problem.errors } : {}),
      ...(problem.extra ?? {}),
    });
};

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound("Route"));
