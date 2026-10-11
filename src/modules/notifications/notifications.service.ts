import { Resend } from 'resend';
import { config } from '../../config/index.js';
import { InternalError, ValidationError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { decodeCursor, toPage, type Page, type PageQuery } from '../../core/pagination.js';
import { withTenant } from '../../db/client.js';
import * as notificationsRepo from './notifications.repo.js';
import type { Notification, NotificationKind } from './notifications.schema.js';
import {
  orderEmail,
  passwordResetEmail,
  staffAlertEmail,
  transferAlertEmail,
  verificationEmail,
  type EmailBrand,
  type EmailLocale,
  type OrderEmailData,
  type OrderEmailKind,
  type RenderedEmail,
  type StaffAlertData,
  type StaffAlertKind,
  type TransferAlertData,
} from './notifications.templates.js';

const resend = new Resend(config.resendApiKey);

export type { EmailLocale, OrderEmailData, OrderEmailKind } from './notifications.templates.js';

// What the person reading it sees as the sender's name, when no store is known (a login is global, so some emails —
// a password reset asked from a page that names no store — cannot say which store they come from).
const PLATFORM_NAME = "Pa'Casa";

// The store's name and contact for the header and footer. The tenancy service is loaded when needed: notifications is
// reachable from the auth setup that tenancy's own dependencies load, and a static import would close a cycle.
async function brandFor(tenantId?: string): Promise<EmailBrand> {
  const fallback: EmailBrand = { name: PLATFORM_NAME, webUrl: config.webBaseUrl };
  if (!tenantId) return fallback;
  try {
    const { tenancyService } = await import('../tenancy/index.js');
    const store = await tenancyService.getPublicStore(tenantId);
    return { name: store.name, webUrl: config.webBaseUrl, supportEmail: store.contact.email, supportPhone: store.contact.phone };
  } catch (err) {
    logger.warn({ err }, 'Could not read the store for an email header; using the platform name');
    return fallback;
  }
}

// The one place an email leaves the building. Outside production nothing is emailed (SEND_EMAILS) and the event is
// logged without the address or names (CLAUDE.md section 13: no PII) — except links, which are the whole point of
// trying a flow without a Resend key, and never in production.
async function deliver(to: string, mail: RenderedEmail, what: string, devLog: Record<string, unknown> = {}): Promise<void> {
  if (!config.sendEmails) {
    logger.info(devLog, `${what} (not emailed: sending is off)`);
    return;
  }
  // Addresses on reserved test domains (the demo accounts are @example.com) can never receive mail, and Resend refuses
  // them outright: skip instead of sending, so a demo order does not queue five doomed retries.
  if (isUndeliverableTestAddress(to)) {
    logger.info({ ...devLog, reason: 'reserved test domain' }, `${what} (not emailed: the address is a test address)`);
    return;
  }
  const { error } = await resend.emails.send({ from: config.emailFrom, to, subject: mail.subject, html: mail.html, text: mail.text });
  if (error) {
    // A refusal that repeating cannot fix (the address or the message itself is rejected) is logged once and dropped:
    // retrying it five times only fills the log and delays the real work behind it. Anything else (rate limit, the
    // provider being down, a bad key) throws, so the queue retries it with backoff.
    if (isPermanentSendError(error)) {
      logger.warn({ ...devLog, providerError: error.name }, `${what} was refused by the email provider and will not be retried`);
      return;
    }
    throw new InternalError(`Could not send the ${what}: ${error.message}`);
  }
}

// RFC 2606 / 6761 reserved names: nothing is ever delivered there.
const RESERVED_SUFFIXES = ['example.com', 'example.org', 'example.net', '.test', '.invalid', '.localhost', '.example'];
export function isUndeliverableTestAddress(address: string): boolean {
  const domain = address.trim().toLowerCase().split('@').at(-1) ?? '';
  return RESERVED_SUFFIXES.some((suffix) => (suffix.startsWith('.') ? domain.endsWith(suffix) : domain === suffix || domain.endsWith(`.${suffix}`)));
}

// Resend's validation errors (HTTP 400/422) describe the request, which a retry would repeat unchanged.
export function isPermanentSendError(error: { name?: string; statusCode?: number | null }): boolean {
  return error.name === 'validation_error' || error.name === 'invalid_to_address' || error.statusCode === 422 || error.statusCode === 400;
}

interface AccountEmailOptions {
  /** The person's own language (users.locale); Spanish when unknown. */
  locale?: EmailLocale;
  /** The store the request was for, so the email carries its name. */
  tenantId?: string;
}

// The "confirm your email" link sent once after a buyer signs up (and again on request). Called from the SuperTokens
// email-delivery hook in core/supertokens.ts.
async function sendEmailVerificationLink(email: string, link: string, options: AccountEmailOptions = {}): Promise<void> {
  const mail = verificationEmail(options.locale ?? 'es', await brandFor(options.tenantId), link);
  await deliver(email, mail, 'email verification message', { link });
}

// The password-reset link for accounts with a password. The link carries a single-use secret token that is valid for
// about an hour. Outside production the link goes to the log: the one place a token is logged — never in production,
// and never the address.
async function sendPasswordResetLink(email: string, link: string, options: AccountEmailOptions = {}): Promise<void> {
  const mail = passwordResetEmail(options.locale ?? 'es', await brandFor(options.tenantId), link);
  await deliver(email, mail, 'password reset email', { link });
}

export interface SendOrderEmail {
  kind: OrderEmailKind;
  locale: EmailLocale;
  tenantId: string;
  data: OrderEmailData;
}

// An email about an order, to its buyer: placed, paid, on the way, delivered, cancelled, refunded, or a payment reminder.
async function sendOrderEmail(email: string, input: SendOrderEmail): Promise<void> {
  const mail = orderEmail(input.kind, input.locale, await brandFor(input.tenantId), input.data);
  await deliver(email, mail, 'order email', { orderNumber: input.data.orderNumber, kind: input.kind, locale: input.locale });
}

// To the store: a buyer says they sent a manual transfer, go and check the account. The amount and order number tell
// them what to look for; marking it paid is a deliberate act in the admin. The store reads Spanish.
async function sendTransferReportedEmail(to: string, tenantId: string, data: TransferAlertData): Promise<void> {
  const mail = transferAlertEmail('es', await brandFor(tenantId), data);
  await deliver(to, mail, 'transfer reported email', { orderNumber: data.orderNumber });
}

// To the store's admins: a new order, a delivery done, or a courier who could not deliver. Spanish, like the other alerts.
async function sendStaffAlertEmail(to: string, tenantId: string, kind: StaffAlertKind, data: StaffAlertData): Promise<void> {
  const mail = staffAlertEmail(kind, await brandFor(tenantId), data);
  await deliver(to, mail, 'store alert email', { orderNumber: data.orderNumber, kind });
}

// --- the in-app feed (the bell) ----------------------------------------------------------------------------------------

export interface NotifyInput {
  kind: NotificationKind;
  orderId?: string;
  orderNumber?: string;
  /** A few facts for the sentence. Never an address, phone or amount. */
  data?: Record<string, string>;
  /** The announcement this is for, so a retried job does not tell anyone twice. */
  eventKey?: string;
}

// Tells these people. Never throws into the caller: a lost bell entry must not undo what it was about.
async function notifyUsers(tenantId: string, userIds: string[], input: NotifyInput): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  try {
    await withTenant(tenantId, (tx) =>
      notificationsRepo.insertMany(
        tx,
        unique.map((userId) => ({
          tenantId,
          userId,
          kind: input.kind,
          orderId: input.orderId ?? null,
          orderNumber: input.orderNumber ?? null,
          data: input.data ?? {},
          eventKey: input.eventKey ?? null,
        })),
      ),
    );
  } catch (err) {
    logger.warn({ err, kind: input.kind }, 'Could not save an in-app notification');
  }
}

export interface NotificationView {
  id: string;
  kind: string;
  orderId: string | null;
  orderNumber: string | null;
  data: Record<string, string>;
  read: boolean;
  createdAt: Date;
}

const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseCursor(cursor: string | undefined): [string, string] | undefined {
  if (!cursor) return undefined;
  const [at, id] = decodeCursor(cursor, 2).map(String) as [string, string];
  if (!ISO_MICROS.test(at) || !UUID.test(id)) throw new ValidationError('That page cursor is not valid', { reason: 'BAD_CURSOR' });
  return [at, id];
}

const toView = (row: Notification): NotificationView => ({
  id: row.id,
  kind: row.kind,
  orderId: row.orderId,
  orderNumber: row.orderNumber,
  data: row.data,
  read: row.readAt !== null,
  createdAt: row.createdAt,
});

// A person's own feed, newest first.
async function pageForUser(tenantId: string, userId: string, page: PageQuery, unreadOnly = false): Promise<Page<NotificationView>> {
  const after = parseCursor(page.cursor);
  const rows = await withTenant(tenantId, (tx) => notificationsRepo.pageForUser(tx, userId, { limit: page.limit + 1, after, unreadOnly }));
  const result = toPage(rows, page.limit, (row) => [row.cursorAt, row.id]);
  return { items: result.items.map(toView), nextCursor: result.nextCursor };
}

async function unreadCount(tenantId: string, userId: string): Promise<number> {
  return withTenant(tenantId, (tx) => notificationsRepo.countUnread(tx, userId));
}

async function markRead(tenantId: string, userId: string, ids: string[] | 'all'): Promise<void> {
  await withTenant(tenantId, (tx) => notificationsRepo.markRead(tx, userId, ids));
}

// Housekeeping, run with the worker's periodic pass: a feed keeps 60 days.
async function pruneOld(tenantId: string, now: Date = new Date()): Promise<number> {
  return withTenant(tenantId, (tx) => notificationsRepo.deleteOlderThan(tx, new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000)));
}

// Business logic for Resend templates, wa.me deep link helpers.
// This is the ONLY public surface other modules may import (via index.ts).
export const notificationsService = {
  sendEmailVerificationLink,
  sendPasswordResetLink,
  sendOrderEmail,
  sendTransferReportedEmail,
  sendStaffAlertEmail,
  notifyUsers,
  pageForUser,
  unreadCount,
  markRead,
  pruneOld,
};
