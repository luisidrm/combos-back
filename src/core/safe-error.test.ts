import { describe, expect, it } from 'vitest';
import { serializeError } from './safe-error.js';

// What Drizzle actually throws: the message embeds the SQL and every bound
// value. The Postgres error underneath has the values in `detail`.
class FakeDrizzleQueryError extends Error {
  constructor(
    readonly query: string,
    readonly params: unknown[],
    override readonly cause: Error,
  ) {
    super(`Failed query: ${query}\nparams: ${params.join(',')}`);
    this.name = 'DrizzleQueryError';
  }
}

class FakePostgresError extends Error {
  code = '23505';
  constraint_name = 'users_tenant_supertokens_user_uq';
  table_name = 'users';
  detail = 'Key (email)=(maria.perez@example.com) already exists.';
}

function driverError(): FakeDrizzleQueryError {
  const pg = new FakePostgresError('duplicate key value violates unique constraint "users_tenant_supertokens_user_uq"');
  return new FakeDrizzleQueryError(
    'insert into "recipients" ("full_name", "phone_1", "street") values ($1, $2, $3)',
    ['María Pérez', '+53 5 1234567', 'Calle 23 #456 e/ L y M'],
    pg,
  );
}

describe('serializeError', () => {
  it('never lets a query error carry its bound values into the log', () => {
    const logged = JSON.stringify(serializeError(driverError()));
    for (const secret of ['María Pérez', '+53 5 1234567', 'Calle 23', 'maria.perez@example.com', 'params:']) {
      expect(logged).not.toContain(secret);
    }
  });

  it('still says what went wrong: the Postgres code, constraint and table', () => {
    expect(serializeError(driverError())).toMatchObject({
      type: 'FakeDrizzleQueryError',
      code: '23505',
      constraint: 'users_tenant_supertokens_user_uq',
      table: 'users',
    });
  });

  it('keeps stack frames but not the message that leads a stack trace', () => {
    const { stack } = serializeError(driverError()) as { stack?: string };
    expect(stack).toBeDefined();
    expect(stack).not.toContain('María');
    expect(stack).not.toContain('Failed query');
    expect(stack?.split('\n').every((line) => /^\s+at /.test(line))).toBe(true);
  });

  it('passes an ordinary error through, truncating a huge message', () => {
    expect(serializeError(new TypeError('boom'))).toMatchObject({ type: 'TypeError', message: 'boom' });
    const long = serializeError(new Error('x'.repeat(5000))) as { message: string };
    expect(long.message.length).toBeLessThan(600);
  });

  it('follows the cause chain of a non-query error', () => {
    const outer = new Error('outer', { cause: new Error('inner') });
    expect(serializeError(outer)).toMatchObject({ message: 'outer', cause: { message: 'inner' } });
  });

  it('does not echo an arbitrary thrown value', () => {
    expect(JSON.stringify(serializeError({ email: 'secret@example.com' }))).not.toContain('secret@');
    expect(JSON.stringify(serializeError('a string with María in it'))).not.toContain('María');
  });
});
