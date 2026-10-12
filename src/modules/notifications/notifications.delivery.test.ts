import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NotificationsServiceModule from './notifications.service.js';

// What happens to an email once it reaches the provider: reserved test addresses are never sent, a refusal that repeating
// cannot fix is dropped after one log line, and a temporary failure still throws so the queue retries it.
const send = vi.fn();
vi.mock('resend', () => ({ Resend: class { emails = { send }; } }));
vi.mock('../../core/queue.js', () => ({ redisConnection: {} }));

describe('email delivery', () => {
  let service: typeof NotificationsServiceModule;

  beforeAll(async () => {
    process.env.SEND_EMAILS = 'true';
    process.env.EMAIL_TEMPLATES = 'resend';
    service = await import('./notifications.service.js');
  });
  beforeEach(() => send.mockReset());

  const order = { kind: 'paid' as const, locale: 'es' as const, tenantId: crypto.randomUUID(), data: { buyerName: 'Ana', orderNumber: 'FC-1', recipientName: 'María', orderUrl: 'https://x.test/o', totalCents: 1000 } };

  it('recognises the addresses that can never receive mail', () => {
    for (const a of ['ana@example.com', 'ANA@Example.COM', 'a@mail.example.org', 'a@host.test', 'a@x.invalid', 'a@localhost.localhost']) {
      expect(service.isUndeliverableTestAddress(a), a).toBe(true);
    }
    for (const a of ['ana@gmail.com', 'ana@myexample.com', 'ana@example.com.cu', 'ana@testing.io']) {
      expect(service.isUndeliverableTestAddress(a), a).toBe(false);
    }
  });

  it('does not even try to send to a test address', async () => {
    await service.notificationsService.sendOrderEmail('buyer1@example.com', order);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends to a real address', async () => {
    send.mockResolvedValue({ data: { id: '1' }, error: null });
    await service.notificationsService.sendOrderEmail('ana@gmail.com', order);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends through the Resend template when that is switched on, with only the variables it uses', async () => {
    send.mockResolvedValue({ data: { id: '1' }, error: null });
    await service.notificationsService.sendOrderEmail('ana@gmail.com', order);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]?.[0] as { template?: { id: string; variables: Record<string, string> }; html?: string; subject?: string };
    expect(payload.template?.id).toBe('pacasa-order-paid-es');
    expect(Object.keys(payload.template?.variables ?? {}).sort()).toEqual(['BRAND_NAME', 'BRAND_URL', 'GREETING', 'ORDER_NUMBER', 'ORDER_URL', 'RECIPIENT_NAME', 'SUPPORT']); // the paid email does not show the total
    expect(payload.html).toBeUndefined(); // Resend refuses html together with a template
    expect(payload.subject).toContain('FC-1');
  });

  it('sends the SAME email the ordinary way when Resend does not accept the template', async () => {
    send
      .mockResolvedValueOnce({ data: null, error: { name: 'not_found', statusCode: 404, message: 'Template not found' } })
      .mockResolvedValueOnce({ data: { id: '2' }, error: null });
    await service.notificationsService.sendOrderEmail('ana@gmail.com', order);
    expect(send).toHaveBeenCalledTimes(2);
    const second = send.mock.calls[1]?.[0] as { template?: unknown; html?: string; text?: string };
    expect(second.template).toBeUndefined();
    expect(second.html).toContain('<html');
    expect(second.text).toContain('FC-1');
  });

  it('drops a refusal that a retry cannot fix, instead of failing the job', async () => {
    send.mockResolvedValue({ data: null, error: { name: 'validation_error', statusCode: 422, message: 'Invalid `to` field' } });
    await expect(service.notificationsService.sendOrderEmail('ana@gmail.com', order)).resolves.toBeUndefined();
  });

  it('still throws on a temporary failure, so the queue retries', async () => {
    send.mockResolvedValue({ data: null, error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' } });
    await expect(service.notificationsService.sendOrderEmail('ana@gmail.com', order)).rejects.toThrow('Could not send');
    send.mockResolvedValue({ data: null, error: { name: 'application_error', statusCode: 500, message: 'boom' } });
    await expect(service.notificationsService.sendOrderEmail('ana@gmail.com', order)).rejects.toThrow('Could not send');
  });
});
