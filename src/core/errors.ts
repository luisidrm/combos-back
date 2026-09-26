export abstract class AppError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly code: string;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  readonly httpStatus = 400;
  readonly code = 'VALIDATION_ERROR';
}

export class UnauthorizedError extends AppError {
  readonly httpStatus = 401;
  readonly code = 'UNAUTHORIZED';
}

export class ForbiddenError extends AppError {
  readonly httpStatus = 403;
  readonly code = 'FORBIDDEN';
}

export class NotFoundError extends AppError {
  readonly httpStatus = 404;
  readonly code = 'NOT_FOUND';
}

export class ConflictError extends AppError {
  readonly httpStatus = 409;
  readonly code = 'CONFLICT';
}

export class InternalError extends AppError {
  readonly httpStatus = 500;
  readonly code = 'INTERNAL_ERROR';
}

export class TooManyRequestsError extends AppError {
  readonly httpStatus = 429;
  readonly code = 'TOO_MANY_REQUESTS';
}
