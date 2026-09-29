import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { config } from '../../../config/index.js';
import { ConflictError, InternalError } from '../../../core/errors.js';
import { logger } from '../../../core/logger.js';
import type {
  CheckoutOrder,
  CheckoutSession,
  PaymentProvider,
  PaymentStatus,
  RefundResult,
  WebhookResult,
} from '../payments.provider.js';

// TropiPay Business Open API v3 (EU-regulated; CLAUDE.md section 2's only
// allowed card/wallet gateway — never Stripe/PayPal/Square/Braintree).
//
// ================================ IMPORTANT ================================
// This is implemented against TropiPay's publicly documented API shape to
// the best available knowledge, but has NOT been exercised against a real
// TropiPay account: `.env`'s TROPIPAY_CLIENT_ID/SECRET are empty, and there
// is no sandbox access in this environment to verify against. Before this
// takes real money:
//   1. Confirm the base URL, endpoint paths and request/response field
//      names below against TropiPay's current API reference — API details
//      drift, and these were not empirically checked here.
//   2. Confirm the webhook's actual signing scheme (header name, algorithm,
//      canonicalisation) against their docs or a captured real webhook —
//      `WEBHOOK_SIGNATURE_HEADER` and the HMAC-over-raw-body check below are
//      a reasonable, common default, not a confirmed one.
//   3. Confirm TropiPay settles in the currency this platform charges in
//      (USD) — if not, a conversion step belongs here, using
//      `currency_rates` (CLAUDE.md section 5), not a silent assumption.
//   4. Run a full checkout → webhook → refund cycle in their sandbox and
//      only then remove this notice.
// `ManualTransferProvider` has none of these gaps and needs no such notice.
// =============================================================================

const BASE_URL = config.tropipay.env === 'production' ? 'https://www.tropipay.com/api/v3' : 'https://sandbox.tropipay.me/api/v3';

const WEBHOOK_SIGNATURE_HEADER = 'x-tropipay-signature';

interface AccessToken {
  value: string;
  expiresAt: number;
}

interface TropiPayPaymentCard {
  id: string;
  shortUrl: string;
  reference: string;
}

function isPaymentStatus(value: unknown): value is PaymentStatus {
  return value === 'pending' || value === 'paid' || value === 'failed' || value === 'refunded';
}

export class TropiPayProvider implements PaymentProvider {
  private cachedToken: AccessToken | undefined;

  constructor(
    private readonly clientId = config.tropipay.clientId,
    private readonly clientSecret = config.tropipay.clientSecret,
  ) {}

  private requireCredentials(): { clientId: string; clientSecret: string } {
    if (!this.clientId || !this.clientSecret) {
      throw new InternalError('TropiPay is not configured (TROPIPAY_CLIENT_ID/TROPIPAY_CLIENT_SECRET are unset)');
    }
    return { clientId: this.clientId, clientSecret: this.clientSecret };
  }

  // Standard OAuth2 client-credentials grant, cached until shortly before
  // expiry. This part of the flow is a common, well-understood pattern —
  // the endpoint path is the one detail of it still worth confirming.
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 30_000) {
      return this.cachedToken.value;
    }

    const { clientId, clientSecret } = this.requireCredentials();
    const response = await fetch(`${BASE_URL}/access/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
    if (!response.ok) {
      throw new InternalError(`TropiPay authentication failed (HTTP ${response.status})`);
    }
    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.cachedToken = { value: body.access_token, expiresAt: now + body.expires_in * 1000 };
    return this.cachedToken.value;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    if (!response.ok) {
      const body = await response.text();
      logger.error({ status: response.status, path, body: body.slice(0, 500) }, 'TropiPay API call failed');
      throw new InternalError(`TropiPay API call to "${path}" failed (HTTP ${response.status})`);
    }
    return (await response.json()) as T;
  }

  // The reference passed to TropiPay carries our own tenant+payment ids, so
  // the webhook can be routed to the right tenant (and the right row)
  // without ever needing to read across tenants or bypass RLS — see
  // payments.provider.ts's WebhookResult for why this exists at all.
  private static encodeReference(tenantId: string, paymentId: string): string {
    return `${tenantId}.${paymentId}`;
  }

  private static decodeReference(reference: string): { tenantId: string; paymentId: string } {
    const [tenantId, paymentId] = reference.split('.');
    if (!tenantId || !paymentId) {
      throw new ConflictError('Malformed payment reference in webhook payload');
    }
    return { tenantId, paymentId };
  }

  async createCheckout(order: CheckoutOrder): Promise<CheckoutSession> {
    // NOTE: field names (amount, currency, concept, urlSuccess/urlFailed,
    // reference) follow TropiPay's general "payment card" shape as publicly
    // documented; verify against the current reference before relying on
    // this (see the module notice above).
    const card = await this.request<TropiPayPaymentCard>('/paymentcards', {
      method: 'POST',
      body: JSON.stringify({
        amount: order.amountCents,
        currency: order.currency,
        concept: order.description,
        reference: TropiPayProvider.encodeReference(order.tenantId, order.paymentId),
        singleUse: true,
        urlSuccess: order.returnUrl,
        urlFailed: order.cancelUrl,
        client: { email: order.buyerEmail },
      }),
    });
    return { redirectUrl: card.shortUrl, externalPaymentId: card.id };
  }

  // NOTE: the header name and HMAC-over-raw-body scheme below is a common
  // pattern for this kind of API, not a confirmed detail of TropiPay's own
  // webhook signing — verify before relying on it (see the module notice).
  async verifyWebhook(req: Request): Promise<WebhookResult> {
    const { clientSecret } = this.requireCredentials();
    const signature = req.header(WEBHOOK_SIGNATURE_HEADER);
    // req.body must be the raw bytes here, not JSON already parsed by
    // express.json() — see payments.routes.ts, which mounts this route with
    // its own raw-body parser ahead of the app-wide express.json().
    const rawBody = req.body as Buffer;
    if (!signature || !Buffer.isBuffer(rawBody)) {
      throw new ConflictError('Missing or unreadable webhook signature');
    }

    const expected = createHmac('sha256', clientSecret).update(rawBody).digest('hex');
    const provided = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
      throw new ConflictError('Invalid webhook signature');
    }

    const payload = JSON.parse(rawBody.toString('utf8')) as {
      id: string;
      reference: string;
      status: string;
      amount: number;
    };
    const { tenantId, paymentId } = TropiPayProvider.decodeReference(payload.reference);
    const status: PaymentStatus = isPaymentStatus(payload.status) ? payload.status : 'failed';

    return {
      tenantId,
      paymentId,
      providerEventId: payload.id,
      eventType: `tropipay.${status}`,
      status,
      amountCents: payload.amount,
      rawPayload: payload,
    };
  }

  async getStatus(externalPaymentId: string): Promise<PaymentStatus> {
    const card = await this.request<{ status: string }>(`/paymentcards/${externalPaymentId}`, { method: 'GET' });
    return isPaymentStatus(card.status) ? card.status : 'failed';
  }

  async refund(externalPaymentId: string, amountCents: number): Promise<RefundResult> {
    const result = await this.request<{ id: string; status: string }>(`/paymentcards/${externalPaymentId}/refund`, {
      method: 'POST',
      body: JSON.stringify({ amount: amountCents }),
    });
    const status = result.status === 'completed' || result.status === 'pending' ? result.status : 'failed';
    return { refundId: result.id, status };
  }
}
