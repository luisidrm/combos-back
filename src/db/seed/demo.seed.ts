import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import supertokens from 'supertokens-node';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import EmailVerification from 'supertokens-node/recipe/emailverification';
import Session from 'supertokens-node/recipe/session';
import { z } from 'zod';
import { events } from '../../core/events.js';
import { MEDIA_BUCKET, minioClient } from '../../core/minio.js';
import { initSupertokens, SUPERTOKENS_TENANT } from '../../core/supertokens.js';
import { cartService } from '../../modules/cart/index.js';
import { catalogService } from '../../modules/catalog/index.js';
import { fulfilmentService } from '../../modules/fulfilment/index.js';
import { geoService } from '../../modules/geo/index.js';
import { identityService, type Role } from '../../modules/identity/index.js';
import { mediaService } from '../../modules/media/index.js';
import { ordersService } from '../../modules/orders/index.js';
import { tenancyService } from '../../modules/tenancy/index.js';
import { sqlClient, withTenant } from '../client.js';

// Fills a store with believable demo data: one login per role, categories, ten products with
// pictures, and orders (most of them delivered, back-dated over the last month so the analytics
// have something to show). Everything goes through the real services, so order numbers,
// snapshots, delivery proof and audit entries are genuine. Safe to re-run: it adds only what is
// missing and never touches an existing password.
//
//   npm run db:seed:demo        (the store and admin must exist: npm run db:seed:admin first)
//
// The pictures are generated colour washes, not photographs: this is placeholder data.
const env = z
  .object({
    SEED_TENANT_SLUG: z.string().min(1).default('demo'),
    SEED_ADMIN_EMAIL: z.string().email(),
    SEED_ADMIN_PASSWORD: z.string().min(1),
    DEMO_PASSWORD: z.string().default('correcthorse7'),
  })
  .parse(process.env);

const DEMO_NOTE = 'demo-seed';

// --- users ------------------------------------------------------------------

interface DemoUser {
  email: string;
  password: string;
  role: Role;
  fullName: string;
  phone: string;
}

async function ensureUser(tenantId: string, who: DemoUser) {
  const signUp = await EmailPassword.signUp(SUPERTOKENS_TENANT, who.email, who.password);
  const existing = await supertokens.listUsersByAccountInfo(SUPERTOKENS_TENANT, { email: who.email });
  const authUser =
    signUp.status === 'OK'
      ? signUp.user
      : existing.find((candidate) => candidate.loginMethods.some((m) => m.recipeId === 'emailpassword'));
  if (!authUser) throw new Error(`Could not create or find the login for ${who.email}`);

  const recipeUserId = authUser.loginMethods.find((m) => m.recipeId === 'emailpassword')?.recipeUserId;
  if (recipeUserId) {
    const token = await EmailVerification.createEmailVerificationToken(SUPERTOKENS_TENANT, recipeUserId, who.email);
    if (token.status === 'OK') await EmailVerification.verifyEmailUsingToken(SUPERTOKENS_TENANT, token.token);
  }

  const user = await identityService.findOrCreateFromSession(tenantId, authUser.id, who.email, who.role, {
    fullName: who.fullName,
    phone: who.phone,
  });
  if (user.role !== who.role) {
    await identityService.setRole(tenantId, user.id, who.role);
    await Session.revokeAllSessionsForUser(authUser.id);
  }
  // An existing row keeps its profile; fill in a missing name so the admin queue shows people, not emails.
  await withTenant(tenantId, (tx) =>
    tx.execute(sql`UPDATE users SET full_name = ${who.fullName}, phone = COALESCE(phone, ${who.phone}) WHERE id = ${user.id} AND full_name IS NULL`),
  );
  console.log(`  ${signUp.status === 'OK' ? 'created' : 'found  '} ${who.role.padEnd(7)} ${who.email}`);
  return user;
}

// --- pictures ----------------------------------------------------------------

const PUBLIC_HEADERS = { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' };

// A soft two-tone wash with a few pale discs, tinted by `hue`. No text: no fonts to depend on.
async function washWebp(hue: number, width: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 55% 78%)"/><stop offset="1" stop-color="hsl(${(hue + 28) % 360} 60% 52%)"/>
    </linearGradient></defs>
    <rect width="1200" height="1200" fill="url(#g)"/>
    <circle cx="600" cy="620" r="330" fill="hsl(${hue} 70% 94%)" opacity=".85"/>
    <circle cx="600" cy="620" r="230" fill="hsl(${hue} 50% 70%)" opacity=".55"/>
    <circle cx="260" cy="230" r="120" fill="hsl(${hue} 80% 96%)" opacity=".5"/>
    <circle cx="960" cy="980" r="150" fill="hsl(${(hue + 40) % 360} 70% 90%)" opacity=".45"/>
  </svg>`;
  return sharp(Buffer.from(svg)).resize({ width }).webp({ quality: 82 }).toBuffer();
}

// Stores the three public derivatives and records a ready `media` row for the owner — what the real
// pipeline produces after an upload, minus the upload. Returns nothing; the owner just has a picture.
async function addReadyPicture(tenantId: string, ownerType: 'product' | 'delivery', ownerId: string, hue: number, cover: boolean) {
  const mediaId = crypto.randomUUID();
  const base = `public/${tenantId}/${ownerType}/${ownerId}/${mediaId}`;
  const keys = { thumb: `${base}.thumb.webp`, card: `${base}.card.webp`, full: `${base}.full.webp` };
  const widths = { thumb: 300, card: 800, full: 1200 } as const;
  for (const name of ['thumb', 'card', 'full'] as const) {
    await minioClient.putObject(MEDIA_BUCKET, keys[name], await washWebp(hue, widths[name]), PUBLIC_HEADERS);
  }
  await withTenant(tenantId, (tx) =>
    tx.execute(sql`
      INSERT INTO media (id, tenant_id, owner_type, owner_id, is_cover, key_original, key_thumb, key_card, key_full, width, height, status)
      VALUES (${mediaId}, ${tenantId}, ${ownerType}, ${ownerId}, ${cover}, ${`${tenantId}/${ownerType}/${ownerId}/${mediaId}.webp`},
              ${keys.thumb}, ${keys.card}, ${keys.full}, 1200, 1200, 'ready')`),
  );
}

// --- catalog -----------------------------------------------------------------

const CATEGORIES = [
  { key: 'pantry', nameEs: 'Despensa', nameEn: 'Pantry', icon: 'wheat' as const },
  { key: 'meat', nameEs: 'Carnes y embutidos', nameEn: 'Meat & cold cuts', icon: 'beef' as const },
  { key: 'dairy', nameEs: 'Lácteos y huevos', nameEn: 'Dairy & eggs', icon: 'milk' as const },
  { key: 'drinks', nameEs: 'Bebidas', nameEn: 'Drinks', icon: 'cup-soda' as const },
];

const PRODUCTS: Array<{
  nameEs: string;
  nameEn: string;
  category: string;
  unitLabel: string;
  priceCents: number;
  stockStatus: 'available' | 'limited' | 'out';
  descriptionEs: string;
  descriptionEn: string;
  hue: number;
}> = [
  { nameEs: 'Pollo Ahumado', nameEn: 'Smoked Chicken', category: 'meat', unitLabel: '1 lb', priceCents: 1850, stockStatus: 'available', descriptionEs: 'Pollo ahumado listo para cocinar.', descriptionEn: 'Smoked chicken, ready to cook.', hue: 24 },
  { nameEs: 'Arroz Blanco', nameEn: 'White Rice', category: 'pantry', unitLabel: 'saco de 5 lb', priceCents: 750, stockStatus: 'available', descriptionEs: 'Arroz de grano largo, el de todos los días.', descriptionEn: 'Long-grain rice for everyday meals.', hue: 48 },
  { nameEs: 'Frijoles Negros', nameEn: 'Black Beans', category: 'pantry', unitLabel: '2 lb', priceCents: 520, stockStatus: 'available', descriptionEs: 'Frijoles negros secos, seleccionados.', descriptionEn: 'Dried black beans, hand selected.', hue: 262 },
  { nameEs: 'Aceite de Girasol', nameEn: 'Sunflower Oil', category: 'pantry', unitLabel: '1 L', priceCents: 480, stockStatus: 'limited', descriptionEs: 'Aceite vegetal para cocinar y freír.', descriptionEn: 'Vegetable oil for cooking and frying.', hue: 52 },
  { nameEs: 'Azúcar', nameEn: 'Sugar', category: 'pantry', unitLabel: 'bolsa de 5 lb', priceCents: 600, stockStatus: 'available', descriptionEs: 'Azúcar refinada.', descriptionEn: 'Refined white sugar.', hue: 200 },
  { nameEs: 'Leche en Polvo', nameEn: 'Powdered Milk', category: 'dairy', unitLabel: '400 g', priceCents: 890, stockStatus: 'available', descriptionEs: 'Leche entera en polvo.', descriptionEn: 'Whole powdered milk.', hue: 205 },
  { nameEs: 'Huevos', nameEn: 'Eggs', category: 'dairy', unitLabel: 'cartón de 30', priceCents: 1200, stockStatus: 'limited', descriptionEs: 'Huevos frescos de granja.', descriptionEn: 'Fresh farm eggs.', hue: 34 },
  { nameEs: 'Lomo de Cerdo', nameEn: 'Pork Loin', category: 'meat', unitLabel: '1 lb', priceCents: 650, stockStatus: 'available', descriptionEs: 'Lomo de cerdo limpio, sin hueso.', descriptionEn: 'Boneless, trimmed pork loin.', hue: 8 },
  { nameEs: 'Café Molido', nameEn: 'Ground Coffee', category: 'drinks', unitLabel: '250 g', priceCents: 750, stockStatus: 'available', descriptionEs: 'Café tostado y molido.', descriptionEn: 'Roasted ground coffee.', hue: 20 },
  { nameEs: 'Jugo de Guayaba', nameEn: 'Guava Juice', category: 'drinks', unitLabel: '1 L', priceCents: 350, stockStatus: 'out', descriptionEs: 'Néctar de guayaba.', descriptionEn: 'Guava nectar.', hue: 345 },
];
// Every product needs a category; the demo data names one for each product, so a missing one is a typo here.
function failMissingCategory(key: string): never {
  throw new Error(`Demo product refers to an unknown category "${key}"`);
}


async function seedCatalog(tenantId: string) {
  const existingCategories = await catalogService.listCategoriesForAdmin(tenantId);
  const categoryId = new Map<string, string>();
  for (const c of CATEGORIES) {
    const found = existingCategories.find((e) => e.nameEs === c.nameEs);
    const row = found ?? (await catalogService.createCategory(tenantId, { nameEs: c.nameEs, nameEn: c.nameEn, icon: c.icon }));
    categoryId.set(c.key, row.id);
  }

  const existing = await catalogService.listProductsForAdmin(tenantId, {});
  let created = 0;
  const live: Array<{ id: string; priceCents: number; stockStatus: string }> = [];
  for (const p of PRODUCTS) {
    let product: Awaited<ReturnType<typeof catalogService.createProduct>> | undefined = existing.find((e) => e.nameEs === p.nameEs);
    if (!product) {
      product = await catalogService.createProduct(tenantId, {
        nameEs: p.nameEs,
        nameEn: p.nameEn,
        descriptionEs: p.descriptionEs,
        descriptionEn: p.descriptionEn,
        categoryId: categoryId.get(p.category) ?? failMissingCategory(p.category),
        priceCents: p.priceCents,
        unitLabel: p.unitLabel,
        stockStatus: p.stockStatus,
        maxPerOrder: 10,
      });
      created += 1;
    }
    if (!(await mediaService.hasReadyPicture(tenantId, 'product', product.id))) {
      await addReadyPicture(tenantId, 'product', product.id, p.hue, true);
    }
    if (!product.active) product = await catalogService.activateProduct(tenantId, product.id);
    live.push({ id: product.id, priceCents: product.priceCents, stockStatus: product.stockStatus });
  }
  console.log(`  ${created} product(s) created, ${PRODUCTS.length - created} already there`);
  return live;
}

// --- orders ------------------------------------------------------------------

const RECIPIENTS = [
  { fullName: 'María Elena Pérez', phone1: '+53 5 4123456', phone2: '+53 42 281122', street: 'Calle Independencia #112', betweenStreets: 'Maceo y Colón', neighborhood: 'Centro', referencePoints: 'Frente a la farmacia, portal con rejas verdes' },
  { fullName: 'Rafael Gómez', phone1: '+53 5 5234567', phone2: null, street: 'Avenida 9 de Abril #54', betweenStreets: '3ra y 4ta', neighborhood: 'Reparto Escambray', referencePoints: 'Casa azul, al lado de la bodega' },
  { fullName: 'Ana Rosa Delgado', phone1: '+53 5 3345678', phone2: '+53 42 205566', street: 'Calle Luis Estévez #230', betweenStreets: 'Marta Abreu y Cuba', neighborhood: 'Reparto Camacho', referencePoints: 'Apartamento 3, segundo piso' },
  { fullName: 'Jorge Luis Santos', phone1: '+53 5 6456789', phone2: null, street: 'Calle Cuba #418', betweenStreets: 'San Cristóbal y Boniato', neighborhood: 'Sandino', referencePoints: 'Cerca del policlínico' },
];

const BUYERS: DemoUser[] = [
  { email: 'buyer1@example.com', password: env.DEMO_PASSWORD, role: 'buyer', fullName: 'Ana Pérez', phone: '+1 305 555 0101' },
  { email: 'buyer2@example.com', password: env.DEMO_PASSWORD, role: 'buyer', fullName: 'Luis Hernández', phone: '+1 786 555 0142' },
  { email: 'buyer3@example.com', password: env.DEMO_PASSWORD, role: 'buyer', fullName: 'Carla Gómez', phone: '+1 954 555 0187' },
];

// How long ago each delivered order was placed, in days (hours are derived from the index).
const DELIVERED_DAYS_AGO = [29, 27, 24, 22, 19, 17, 14, 12, 9, 7, 5, 4, 3, 2, 1];
const IN_PROGRESS: Array<'paid' | 'preparing' | 'out_for_delivery'> = ['paid', 'preparing', 'out_for_delivery'];

async function seedOrders(
  tenantId: string,
  provinceId: string,
  municipalityId: string,
  products: Array<{ id: string; stockStatus: string }>,
  people: { admin: string; staff: string; courier: string; buyers: string[] },
) {
  const already = (await ordersService.listOrdersForAdmin(tenantId, {})).some((o) => o.buyerNotes === DEMO_NOTE);
  if (already) {
    console.log('  demo orders already there, left alone');
    return;
  }
  const buyable = products.filter((p) => p.stockStatus !== 'out');

  // Each buyer sends to two of the recipients.
  const book = new Map<string, Array<{ recipientId: string; addressId: string; name: string }>>();
  for (const [i, buyer] of people.buyers.entries()) {
    const entries = [];
    for (const r of [RECIPIENTS[i % RECIPIENTS.length], RECIPIENTS[(i + 1) % RECIPIENTS.length]]) {
      if (!r) continue;
      const created = await ordersService.createRecipient(tenantId, buyer, {
        fullName: r.fullName,
        phone1: r.phone1,
        phone2: r.phone2,
        address: { provinceId, municipalityId, street: r.street, betweenStreets: r.betweenStreets, neighborhood: r.neighborhood, referencePoints: r.referencePoints },
      });
      entries.push({ recipientId: created.id, addressId: created.addresses[0]?.id as string, name: r.fullName });
    }
    book.set(buyer, entries);
  }

  async function place(n: number, buyer: string) {
    const target = book.get(buyer)?.[n % 2];
    if (!target) throw new Error('No recipient for the buyer');
    await cartService.clearCart(tenantId, { userId: buyer });
    // A different, deterministic basket per order: 2 to 4 products, 1 to 3 of each.
    const lines = 2 + (n % 3);
    for (let k = 0; k < lines; k += 1) {
      const product = buyable[(n * 3 + k * 2) % buyable.length];
      if (product) await cartService.addItem(tenantId, { userId: buyer }, { productId: product.id, quantity: 1 + ((n + k) % 3) });
    }
    const { order } = await ordersService.checkout(tenantId, buyer, {
      recipientId: target.recipientId,
      addressId: target.addressId,
      provider: 'manual',
      giftMessage: n % 4 === 0 ? 'Para ti, con mucho cariño.' : undefined,
      buyerNotes: DEMO_NOTE,
    });
    return { order, recipientName: target.name };
  }

  const toPaid = async (id: string) => {
    await ordersService.adminMarkPaid(tenantId, people.admin, id);
  };

  let delivered = 0;
  for (const [n, daysAgo] of DELIVERED_DAYS_AGO.entries()) {
    const buyer = people.buyers[n % people.buyers.length] as string;
    const { order, recipientName } = await place(n, buyer);
    await toPaid(order.id);
    await ordersService.adminMarkPreparing(tenantId, people.staff, order.id);
    await ordersService.adminMarkOutForDelivery(tenantId, people.staff, order.id);
    // Proof of delivery: a photo (the store may require one) and who received it.
    await addReadyPicture(tenantId, 'delivery', order.id, (n * 47) % 360, false);
    await fulfilmentService.confirmDelivery(tenantId, people.courier, order.id, {
      recipientName: n % 5 === 0 ? 'Vecina (en nombre de ' + recipientName + ')' : recipientName,
      notes: n % 3 === 0 ? 'Entregado en la puerta.' : undefined,
    });

    // Back-date it: placed in the morning of that day, paid shortly after, delivered a few hours later.
    const placed = new Date();
    placed.setDate(placed.getDate() - daysAgo);
    placed.setHours(8 + (n % 5), 10 + n * 3, 0, 0);
    const paid = new Date(placed.getTime() + 12 * 60_000);
    const done = new Date(placed.getTime() + (3 + (n % 4)) * 3_600_000);
    await withTenant(tenantId, async (tx) => {
      await tx.execute(sql`UPDATE orders SET created_at = ${placed.toISOString()}::timestamptz, placed_at = ${placed.toISOString()}::timestamptz, paid_at = ${paid.toISOString()}::timestamptz, delivered_at = ${done.toISOString()}::timestamptz WHERE id = ${order.id}`);
      await tx.execute(sql`UPDATE deliveries SET delivered_at = ${done.toISOString()}::timestamptz WHERE order_id = ${order.id}`);
    });
    delivered += 1;
  }

  // A few still moving, so the order queue and the courier screen are not empty.
  for (const [i, stage] of IN_PROGRESS.entries()) {
    const buyer = people.buyers[i % people.buyers.length] as string;
    const { order } = await place(DELIVERED_DAYS_AGO.length + i, buyer);
    await toPaid(order.id);
    if (stage === 'paid') continue;
    await ordersService.adminMarkPreparing(tenantId, people.staff, order.id);
    if (stage === 'preparing') continue;
    await ordersService.adminMarkOutForDelivery(tenantId, people.staff, order.id);
  }
  console.log(`  ${delivered} delivered order(s) + ${IN_PROGRESS.length} in progress`);
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  // Demo data includes logins (admin, packer, courier, buyers) whose password is known. On a real deployment that is a
  // hole, so this script refuses outright; the build also leaves it out of the production image (tsconfig.build.json).
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:seed:demo creates accounts with a known password and must never run in production');
  }
  initSupertokens();
  const tenant = await tenancyService.resolveBySlug(env.SEED_TENANT_SLUG);
  console.log(`Seeding "${tenant.slug}"`);

  console.log('Users (password for every demo login except the admin: ' + env.DEMO_PASSWORD + ')');
  const admin = await ensureUser(tenant.id, { email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD, role: 'admin', fullName: 'Administrador Demo', phone: '+53 42 215566' });
  const staff = await ensureUser(tenant.id, { email: 'packer@example.com', password: env.DEMO_PASSWORD, role: 'staff', fullName: 'Pedro Empacador', phone: '+53 5 8123456' });
  const courier = await ensureUser(tenant.id, { email: 'courier@example.com', password: env.DEMO_PASSWORD, role: 'courier', fullName: 'Carlos Mensajero', phone: '+53 5 8765432' });
  const buyers = [];
  for (const b of BUYERS) buyers.push(await ensureUser(tenant.id, b));

  console.log('Catalog');
  const products = await seedCatalog(tenant.id);

  console.log('Orders');
  const zone = (await geoService.listPublicZones(tenant.id)).find((z) => z.municipality.nameEs === 'Santa Clara');
  if (!zone) throw new Error('No delivery zone for Santa Clara — add one in Admin > Settings first');
  await seedOrders(tenant.id, zone.province.id, zone.municipalityId, products, {
    admin: admin.id,
    staff: staff.id,
    courier: courier.id,
    buyers: buyers.map((b) => b.id),
  });
}

main()
  .then(async () => {
    await events.close();
    await sqlClient.end();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error(err);
    await events.close();
    await sqlClient.end();
    process.exit(1);
  });
