import type { NextFunction, Request, Response } from 'express';
import { isUniqueViolation } from '../../db/errors.js';
import { AppError, NotFoundError, TooManyRequestsError } from '../errors.js';
import { logger } from '../logger.js';
import { getRequestId } from '../request-context.js';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

function send(res: Response, status: number, code: string, message: string, details?: unknown): void {
  const body: ErrorBody = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  const requestId = getRequestId();
  if (requestId) body.error.requestId = requestId;
  res.status(status).json(body);
}

// Errors raised by Express' own middleware (body-parser and friends) carry an
// HTTP status and an `expose` flag; they are the client's fault, not ours.
interface HttpClientError {
  status: number;
  type?: string;
}

function asHttpClientError(err: unknown): HttpClientError | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as { status?: unknown; expose?: unknown; type?: unknown };
  if (typeof candidate.status !== 'number' || candidate.status < 400 || candidate.status >= 500) return undefined;
  if (candidate.expose !== true) return undefined;
  return { status: candidate.status, type: typeof candidate.type === 'string' ? candidate.type : undefined };
}

// Unmatched routes get the same JSON shape as every other error, instead of
// Express' default HTML page. Mounted after all routers.
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`No route for ${req.method} ${req.path}`));
}

// Routes never construct status codes by hand — services throw AppError
// subclasses and this is the single place that maps them to HTTP.
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    // Too late to send a JSON error; let Express close the connection.
    next(err);
    return;
  }

  if (err instanceof AppError) {
    logger.warn({ code: err.code, path: req.path }, err.message);
    // However a 429 arose (the per-IP middleware, or a limit inside a service
    // such as the login-code one), the client gets the standard header too.
    if (err instanceof TooManyRequestsError) {
      const retryAfter = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
    }
    send(res, err.httpStatus, err.code, err.message, err.details);
    return;
  }

  const clientError = asHttpClientError(err);
  if (clientError) {
    logger.info({ status: clientError.status, type: clientError.type, path: req.path }, 'Rejected malformed request');
    if (clientError.type === 'entity.parse.failed') {
      send(res, 400, 'BAD_REQUEST', 'The request body is not valid JSON');
    } else if (clientError.type === 'entity.too.large') {
      send(res, 413, 'PAYLOAD_TOO_LARGE', 'The request body is too large');
    } else {
      send(res, clientError.status, 'BAD_REQUEST', 'The request could not be processed');
    }
    return;
  }

  // Safety net: a unique violation nobody translated is still the client
  // asking for something that already exists, not a server fault.
  if (isUniqueViolation(err)) {
    logger.warn({ err, path: req.path }, 'Unique violation reached the error handler');
    send(res, 409, 'CONFLICT', 'That already exists');
    return;
  }

  logger.error({ err, path: req.path }, 'Unhandled error');
  send(res, 500, 'INTERNAL_ERROR', 'Something went wrong');
}
