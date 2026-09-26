// Turns any thrown value into something safe to log. The default pino error
// serializer prints `message` and `stack`, and Drizzle's query errors put the
// whole statement AND its bound parameter values in the message
// ("Failed query: insert into recipients ... params: María Pérez,+53 5...").
// Those parameters are exactly the personal data CLAUDE.md section 13 says
// never to log — names, phones, addresses, emails — and no field-name
// redaction can reach inside a message string.
//
// So for a driver/query error we log the underlying Postgres error's code,
// constraint and table, plus its message (which names the constraint but not
// the values; `detail`, which does contain them, is deliberately dropped).

const MAX_MESSAGE = 500;
const MAX_CAUSE_DEPTH = 3;

interface ErrorLike extends Error {
  code?: unknown;
  constraint?: unknown;
  constraint_name?: unknown;
  table?: unknown;
  table_name?: unknown;
  query?: unknown;
  params?: unknown;
  cause?: unknown;
}

function isErrorLike(value: unknown): value is ErrorLike {
  return value instanceof Error;
}

// A Drizzle query error is recognisable by carrying the SQL and its params.
function carriesQueryData(err: ErrorLike): boolean {
  return err.query !== undefined || err.params !== undefined || err.message.startsWith('Failed query:');
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text;
}

function stackFramesOnly(stack: string | undefined): string | undefined {
  // Keep only the "    at ..." lines: the first line(s) repeat the message.
  return stack
    ?.split('\n')
    .filter((line) => /^\s+at /.test(line))
    .join('\n');
}

export function serializeError(err: unknown, depth = 0): Record<string, unknown> {
  if (!isErrorLike(err)) {
    // Never echo an arbitrary thrown value: it could be an object holding user data.
    return { type: typeof err, message: '[non-Error value thrown]' };
  }

  const queryError = carriesQueryData(err);
  const cause = isErrorLike(err.cause) ? err.cause : undefined;

  const out: Record<string, unknown> = {
    type: err.constructor.name,
    // For a query error the message IS the SQL plus values; the driver error
    // underneath (the cause) says what actually went wrong.
    message: queryError ? (cause ? truncate(cause.message) : 'Database query failed') : truncate(err.message),
  };

  const source = cause && queryError ? cause : err;
  const pgCode = source.code ?? err.code;
  if (typeof pgCode === 'string') out.code = pgCode;
  const constraint = source.constraint_name ?? source.constraint;
  if (typeof constraint === 'string') out.constraint = constraint;
  const table = source.table_name ?? source.table;
  if (typeof table === 'string') out.table = table;

  const stack = stackFramesOnly(err.stack);
  if (stack) out.stack = stack;

  // A non-query error's cause is worth following; for a query error it has
  // already been folded in above.
  if (cause && !queryError && depth < MAX_CAUSE_DEPTH) {
    out.cause = serializeError(cause, depth + 1);
  }
  return out;
}
