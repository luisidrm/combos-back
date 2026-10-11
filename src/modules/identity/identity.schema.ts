import { pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { tenantIsolationPolicy } from '../../db/rls.js';

// staff = the packer: sees and advances orders and flips stock/visibility, but cannot touch
// money, prices, deletions, analytics or settings (see the route guards in orders/catalog).
export const roles = ['buyer', 'admin', 'staff', 'courier'] as const;
export type Role = (typeof roles)[number];

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    supertokensUserId: varchar('supertokens_user_id', { length: 36 }).notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    role: varchar('role', { length: 20 }).notNull().default('buyer'),
    // Collected at buyer signup (the design's form asks for both); null for
    // staff and for accounts created before these columns existed.
    fullName: varchar('full_name', { length: 255 }),
    phone: varchar('phone', { length: 20 }),
    // The language this person reads (one per buyer): set from the site's language at signup, changeable later.
    // Every email to them is written in it, never in both.
    locale: varchar('locale', { length: 5 }).notNull().default('es'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    tenantIsolationPolicy(table.tenantId),
    // SuperTokens users are global (one per email), so the same person can
    // buy from two shops: one `users` row per (tenant, supertokens user),
    // not one per supertokens user.
    uniqueIndex('users_tenant_supertokens_user_uq').on(table.tenantId, table.supertokensUserId),
  ],
);

export const userLocales = ['es', 'en'] as const;
export type UserLocale = (typeof userLocales)[number];

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// --- team management (admin only) ------------------------------------------------

// The roles an admin can give to someone who works for the store. Buyers sign themselves up.
export const teamRoles = ['admin', 'staff', 'courier'] as const;
export type TeamRole = (typeof teamRoles)[number];

// What a signed-in person may change about themselves: the language their emails come in, and the name and phone we
// keep for them (a Google sign-up brings a name but never a phone, so the app asks for it afterwards).
export const updateMeSchema = z
  .object({
    locale: z.enum(userLocales).optional(),
    fullName: z.string().trim().min(1).max(255).optional(),
    // Same loose format as the recipient phone and the signup form: rejects junk, not formatting.
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{7,20}$/, 'not a valid phone number')
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change' });
export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export const inviteMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  fullName: z.string().trim().min(1).max(255),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,20}$/, 'not a valid phone number')
    .optional(),
  role: z.enum(teamRoles),
  // Omit it and the person gets an email with a link to choose their own password (the better way).
  // Give one and they can sign in at once with it (no email needed), then change it themselves.
  password: z.string().optional(),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberSchema = z
  .object({
    role: z.enum(teamRoles).optional(),
    active: z.boolean().optional(),
    fullName: z.string().trim().min(1).max(255).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{7,20}$/, 'not a valid phone number')
      .nullable()
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change' });
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const memberIdParamSchema = z.object({ id: z.string().uuid() });
