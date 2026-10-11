import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ init: vi.fn(), captureException: vi.fn(), flush: vi.fn().mockResolvedValue(true) }));
vi.mock('@sentry/node', () => sentry);
const cfg = vi.hoisted(() => ({ sentryDsn: undefined as string | undefined, sentryEnvironment: 'test' }));
vi.mock('../config/index.js', () => ({ config: cfg }));

describe('error monitoring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function load() {
    return import('./monitoring.js');
  }

  it('sends nothing, and starts nothing, until a DSN is set', async () => {
    cfg.sentryDsn = undefined;
    const monitoring = await load();
    monitoring.initMonitoring('api');
    monitoring.reportError(new Error('boom'));
    expect(sentry.init).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('switches off the SDK extras that could carry personal data', async () => {
    cfg.sentryDsn = 'https://key@example.invalid/1';
    (await load()).initMonitoring('worker');
    const options = sentry.init.mock.calls[0]?.[0];
    expect(options).toMatchObject({ dsn: 'https://key@example.invalid/1', tracesSampleRate: 0, defaultIntegrations: false });
    expect(options.beforeBreadcrumb({ message: 'x' })).toBeNull();
    const event = options.beforeSend({ request: { url: 'https://x/?token=secret', data: 'body' }, user: { email: 'a@b.c' }, message: 'm' });
    expect(event.request).toBeUndefined();
    expect(event.user).toBeUndefined();
  });

  it('never reports a database error as thrown: the SQL and its bound values stay out', async () => {
    cfg.sentryDsn = 'https://key@example.invalid/1';
    const monitoring = await load();
    monitoring.initMonitoring('api');

    // What Drizzle really throws: the statement and the personal data it was bound to, in the message.
    const queryError = Object.assign(new Error('Failed query: insert into recipients (full_name, phone_1) values ($1, $2)\nparams: María Pérez,+53 5 1234567'), {
      query: 'insert into recipients ...',
      params: ['María Pérez', '+53 5 1234567'],
      cause: Object.assign(new Error('duplicate key value violates unique constraint "recipients_pkey"'), { code: '23505', constraint: 'recipients_pkey' }),
    });
    monitoring.reportError(queryError, { path: '/recipients' });

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [sentError, hint] = sentry.captureException.mock.calls[0] as [Error, unknown];
    // An Error's message and stack do not show up in JSON.stringify, so look at them directly.
    const everything = `${sentError.name}\n${sentError.message}\n${sentError.stack}\n${JSON.stringify(hint)}`;
    expect(everything).not.toContain('María');
    expect(everything).not.toContain('+53 5 1234567');
    expect(everything).not.toContain('full_name'); // not even the statement
    expect(everything).toContain('recipients_pkey'); // what actually went wrong is still there
  });

  it('keeps going if the monitor itself fails', async () => {
    cfg.sentryDsn = 'https://key@example.invalid/1';
    sentry.captureException.mockImplementationOnce(() => {
      throw new Error('network down');
    });
    const monitoring = await load();
    monitoring.initMonitoring('api');
    expect(() => monitoring.reportError(new Error('boom'))).not.toThrow();
  });
});
