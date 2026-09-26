import type { NextFunction, Request, Response } from 'express';
import type { ZodError, ZodTypeAny } from 'zod';
import { ValidationError } from '../errors.js';

interface ValidationSchemas {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
}

// What the client is told about each problem: where, which field, and why —
// enough to put a message next to the right input. Deliberately not the raw
// ZodError, which is an implementation detail and can echo submitted values.
export interface FieldIssue {
  location: 'body' | 'params' | 'query';
  path: string;
  code: string;
  message: string;
}

function toFieldIssues(location: FieldIssue['location'], error: ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    location,
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

// Zod at every boundary (CLAUDE.md section 13). Routes declare their
// schemas and get parsed, typed req.body/params/query back.
export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const issues: FieldIssue[] = [];

    // Every part is checked (not just the first to fail) so the client gets
    // all the problems in one response.
    const run = <T>(location: FieldIssue['location'], schema: ZodTypeAny | undefined, input: unknown): T | undefined => {
      if (!schema) return undefined;
      const result = schema.safeParse(input);
      if (result.success) return result.data as T;
      issues.push(...toFieldIssues(location, result.error));
      return undefined;
    };

    const body = run<unknown>('body', schemas.body, req.body);
    const params = run<Request['params']>('params', schemas.params, req.params);
    const query = run<unknown>('query', schemas.query, req.query);

    if (issues.length > 0) {
      next(new ValidationError('Request validation failed', { issues }));
      return;
    }

    if (schemas.body) req.body = body;
    if (schemas.params && params) req.params = params;
    if (schemas.query) {
      // Express 5 defines req.query as a getter-only property on the
      // prototype (parses req.url fresh on every access) — a plain
      // `req.query = ...` throws "Cannot set property query of
      // #<IncomingMessage> which has only a getter". Shadowing it with
      // an own, writable property on this request is the supported way
      // around that; the getter stays configurable specifically for this.
      Object.defineProperty(req, 'query', {
        value: query,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
    next();
  };
}
