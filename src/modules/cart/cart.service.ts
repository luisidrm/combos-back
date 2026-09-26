import { randomBytes } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { withTenant, type Transaction } from '../../db/client.js';
import { catalogService, type ProductSnapshot } from '../catalog/index.js';
import { mediaService } from '../media/index.js';
import * as cartRepo from './cart.repo.js';
import { MAX_LINE_QUANTITY, type Cart, type MergeCartInput } from './cart.schema.js';

// Who is holding the cart: a signed-in buyer (internal users.id), a guest
// (the opaque token we handed them earlier), or — on a first visit —
// neither. Both set means a buyer who still carries their guest token.
export interface CartActor {
  userId?: string;
  guestToken?: string;
}

// The server's verdict on a line, recomputed on every read — prices and
// availability are never trusted from the client's persisted copy
// (CLAUDE.md section 7, "Server cart is authoritative").
export type LineIssue = 'UNAVAILABLE' | 'OUT_OF_STOCK' | 'EXCEEDS_MAX_PER_ORDER';

export interface CartLineView {
  productId: string;
  quantity: number;
  // null when the product was deleted since it was added.
  product: {
    slug: string;
    nameEs: string;
    nameEn: string;
    unitLabel: string;
    unitPriceCents: number;
    stockStatus: string;
    maxPerOrder: number | null;
    picture: { thumbUrl: string; cardUrl: string } | null;
  } | null;
  lineTotalCents: number;
  issue: LineIssue | null;
}

export interface CartView {
  // Only present in the response that created a new guest cart: the client
  // stores it and sends it back as x-cart-token.
  guestToken?: string;
  items: CartLineView[];
  itemCount: number;
  currency: 'USD';
  // Sum of the lines that can actually be bought right now.
  subtotalCents: number;
  // True only when there is at least one line and none has an issue.
  checkoutReady: boolean;
}

// --- helpers --------------------------------------------------------------

function newGuestToken(): string {
  return randomBytes(32).toString('hex');
}

function lineLimit(maxPerOrder: number | null): number {
  return Math.min(MAX_LINE_QUANTITY, maxPerOrder ?? MAX_LINE_QUANTITY);
}

function isPurchasable(product: ProductSnapshot | undefined): product is ProductSnapshot {
  return product !== undefined && product.active && product.stockStatus !== 'out';
}

async function findCart(tx: Transaction, actor: CartActor): Promise<Cart | undefined> {
  if (actor.userId) {
    return cartRepo.findCartByUser(tx, actor.userId);
  }
  if (actor.guestToken) {
    return cartRepo.findCartByGuestToken(tx, actor.guestToken);
  }
  return undefined;
}

// Finds the actor's cart or makes one. A guest with no token, or a token
// we don't recognise (expired, invented), gets a fresh cart and a fresh
// token — the client never gets to choose its own.
async function findOrCreateCart(
  tx: Transaction,
  tenantId: string,
  actor: CartActor,
): Promise<{ cart: Cart; mintedGuestToken?: string }> {
  const existing = await findCart(tx, actor);
  if (existing) {
    return { cart: existing };
  }

  if (actor.userId) {
    const created = await cartRepo.insertCart(tx, { tenantId, userId: actor.userId });
    // Lost a race with a parallel request from the same buyer: use theirs.
    const cart = created ?? (await cartRepo.findCartByUser(tx, actor.userId));
    if (!cart) {
      throw new Error('Cart missing right after insert');
    }
    return { cart };
  }

  const guestToken = newGuestToken();
  const cart = await cartRepo.insertCart(tx, { tenantId, guestToken });
  if (!cart) {
    throw new Error('Could not create a guest cart');
  }
  return { cart, mintedGuestToken: guestToken };
}

async function buildView(
  tenantId: string,
  items: Array<{ productId: string; quantity: number }>,
  guestToken?: string,
): Promise<CartView> {
  const productIds = items.map((item) => item.productId);
  const snapshots = new Map(
    (await catalogService.getProductSnapshots(tenantId, productIds)).map((snapshot) => [snapshot.id, snapshot]),
  );
  const pictures = await mediaService.getPublicPictures(tenantId, 'product', productIds);

  let subtotalCents = 0;
  let itemCount = 0;
  let allClear = items.length > 0;

  const lines = items.map((item): CartLineView => {
    const snapshot = snapshots.get(item.productId);
    itemCount += item.quantity;

    let issue: LineIssue | null = null;
    if (!snapshot || !snapshot.active) {
      issue = 'UNAVAILABLE';
    } else if (snapshot.stockStatus === 'out') {
      issue = 'OUT_OF_STOCK';
    } else if (snapshot.maxPerOrder !== null && item.quantity > snapshot.maxPerOrder) {
      issue = 'EXCEEDS_MAX_PER_ORDER';
    }

    const lineTotalCents = snapshot && issue === null ? snapshot.priceCents * item.quantity : 0;
    subtotalCents += lineTotalCents;
    if (issue !== null) {
      allClear = false;
    }

    const cover = pictures.get(item.productId)?.[0];
    return {
      productId: item.productId,
      quantity: item.quantity,
      product: snapshot
        ? {
            slug: snapshot.slug,
            nameEs: snapshot.nameEs,
            nameEn: snapshot.nameEn,
            unitLabel: snapshot.unitLabel,
            unitPriceCents: snapshot.priceCents,
            stockStatus: snapshot.stockStatus,
            maxPerOrder: snapshot.maxPerOrder,
            picture: cover ? { thumbUrl: cover.thumbUrl, cardUrl: cover.cardUrl } : null,
          }
        : null,
      lineTotalCents,
      issue,
    };
  });

  return {
    ...(guestToken ? { guestToken } : {}),
    items: lines,
    itemCount,
    currency: 'USD',
    subtotalCents,
    checkoutReady: allClear,
  };
}

async function viewOf(tenantId: string, cartId: string | undefined, guestToken?: string): Promise<CartView> {
  const items = cartId ? await withTenant(tenantId, (tx) => cartRepo.listItems(tx, cartId)) : [];
  return buildView(tenantId, items, guestToken);
}

// --- operations -----------------------------------------------------------

// Reading never creates a cart: a visitor who only browses leaves no rows.
async function getCart(tenantId: string, actor: CartActor): Promise<CartView> {
  const cart = await withTenant(tenantId, (tx) => findCart(tx, actor));
  return viewOf(tenantId, cart?.id);
}

async function addItem(
  tenantId: string,
  actor: CartActor,
  input: { productId: string; quantity: number },
): Promise<CartView> {
  const [product] = await catalogService.getProductSnapshots(tenantId, [input.productId]);
  if (!product || !product.active) {
    throw new NotFoundError('That product is not available');
  }
  if (product.stockStatus === 'out') {
    throw new ConflictError('That product is out of stock', { reason: 'OUT_OF_STOCK' });
  }

  const { cart, mintedGuestToken } = await withTenant(tenantId, async (tx) => {
    const found = await findOrCreateCart(tx, tenantId, actor);

    const existing = await cartRepo.findItem(tx, found.cart.id, input.productId);
    const quantity = (existing?.quantity ?? 0) + input.quantity;
    const limit = lineLimit(product.maxPerOrder);
    if (quantity > limit) {
      throw new ValidationError(`You can order at most ${limit} of this product`, {
        reason: 'EXCEEDS_MAX_PER_ORDER',
        max: limit,
      });
    }

    await cartRepo.upsertItem(tx, { tenantId, cartId: found.cart.id, productId: input.productId, quantity });
    await cartRepo.touchCart(tx, found.cart.id);
    return found;
  });

  return viewOf(tenantId, cart.id, mintedGuestToken);
}

async function setQuantity(
  tenantId: string,
  actor: CartActor,
  productId: string,
  quantity: number,
): Promise<CartView> {
  const [product] = await catalogService.getProductSnapshots(tenantId, [productId]);

  const cart = await withTenant(tenantId, async (tx) => {
    const found = await findCart(tx, actor);
    if (!found || !(await cartRepo.findItem(tx, found.id, productId))) {
      throw new NotFoundError('That product is not in your cart');
    }

    // A product that's gone or hidden can still have its quantity lowered
    // or removed; only a live product's limit is enforced.
    if (product?.active) {
      const limit = lineLimit(product.maxPerOrder);
      if (quantity > limit) {
        throw new ValidationError(`You can order at most ${limit} of this product`, {
          reason: 'EXCEEDS_MAX_PER_ORDER',
          max: limit,
        });
      }
    }

    await cartRepo.upsertItem(tx, { tenantId, cartId: found.id, productId, quantity });
    await cartRepo.touchCart(tx, found.id);
    return found;
  });

  return viewOf(tenantId, cart.id);
}

// Idempotent: removing something that isn't there is not an error.
async function removeItem(tenantId: string, actor: CartActor, productId: string): Promise<CartView> {
  const cart = await withTenant(tenantId, async (tx) => {
    const found = await findCart(tx, actor);
    if (found) {
      await cartRepo.deleteItem(tx, found.id, productId);
      await cartRepo.touchCart(tx, found.id);
    }
    return found;
  });
  return viewOf(tenantId, cart?.id);
}

async function clearCart(tenantId: string, actor: CartActor): Promise<CartView> {
  const cart = await withTenant(tenantId, async (tx) => {
    const found = await findCart(tx, actor);
    if (found) {
      await cartRepo.deleteAllItems(tx, found.id);
      await cartRepo.touchCart(tx, found.id);
    }
    return found;
  });
  return viewOf(tenantId, cart?.id);
}

// Folds the client's locally persisted cart — and, for a buyer who just
// signed in, their guest cart — into the server cart, then returns the
// server's fresh view (CLAUDE.md section 7).
//
// The rule per product is "the larger of the two quantities", not the sum.
// The client re-sends its whole local cart on every mount, so summing would
// double it each time; max makes the call idempotent. Products that are
// gone, hidden or out of stock are skipped rather than merged — the
// response shows the server's truth either way.
async function mergeCart(tenantId: string, actor: CartActor, input: MergeCartInput): Promise<CartView> {
  const incoming = new Map<string, number>(input.items.map((item) => [item.productId, item.quantity]));

  // A signed-in buyer who still carries a guest token: absorb that cart too.
  const guestCartToAbsorb =
    actor.userId && actor.guestToken
      ? await withTenant(tenantId, async (tx) => {
          const guestCart = await cartRepo.findCartByGuestToken(tx, actor.guestToken as string);
          if (!guestCart) {
            return undefined;
          }
          for (const item of await cartRepo.listItems(tx, guestCart.id)) {
            incoming.set(item.productId, Math.max(incoming.get(item.productId) ?? 0, item.quantity));
          }
          return guestCart;
        })
      : undefined;

  const snapshots = new Map(
    (await catalogService.getProductSnapshots(tenantId, [...incoming.keys()])).map((snapshot) => [
      snapshot.id,
      snapshot,
    ]),
  );

  // Once a signed-in buyer's guest cart is folded in, the buyer's own cart
  // is the one to look up from here on.
  const owner: CartActor = actor.userId ? { userId: actor.userId } : { guestToken: actor.guestToken };

  const { cart, mintedGuestToken } = await withTenant(tenantId, async (tx) => {
    const found = await findOrCreateCart(tx, tenantId, owner);

    for (const [productId, wanted] of incoming) {
      const product = snapshots.get(productId);
      if (!isPurchasable(product)) {
        continue;
      }
      const existing = await cartRepo.findItem(tx, found.cart.id, productId);
      const quantity = Math.min(Math.max(existing?.quantity ?? 0, wanted), lineLimit(product.maxPerOrder));
      await cartRepo.upsertItem(tx, { tenantId, cartId: found.cart.id, productId, quantity });
    }
    await cartRepo.touchCart(tx, found.cart.id);

    if (guestCartToAbsorb) {
      await cartRepo.deleteCart(tx, guestCartToAbsorb.id);
    }
    return found;
  });

  return viewOf(tenantId, cart.id, mintedGuestToken);
}

// Guests never log in, so nothing ever ties a guest cart back to a person and
// abandoned ones would pile up forever (anyone can create one, unauthenticated).
// Run periodically by the worker process, once per tenant.
const STALE_GUEST_CART_DAYS = 30;

async function purgeStaleGuestCarts(tenantId: string, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_GUEST_CART_DAYS * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const ids = await cartRepo.findStaleGuestCartIds(tx, cutoff);
    for (const id of ids) {
      await cartRepo.deleteCart(tx, id);
    }
    return ids.length;
  });
}

// The only public surface other modules may import (via index.ts).
export const cartService = { getCart, addItem, setQuantity, removeItem, clearCart, mergeCart, purgeStaleGuestCarts };
