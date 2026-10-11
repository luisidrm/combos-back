import { describe, expect, it } from 'vitest';
import { updateTenantSchema } from './tenancy.schema.js';

// The shop-profile form sends every field, empty ones as "". That used to fail validation on the
// email (an empty string is not an address), so saving a profile without one was a 400.
describe('updateTenantSchema: the shop profile form', () => {
  it('reads a blank contact field as "clear it"', () => {
    const parsed = updateTenantSchema.parse({
      name: 'Demo Shop',
      settings: { contact: { phone: '', email: '  ', address: '' }, requireDeliveryPhoto: false },
    });
    expect(parsed.settings?.contact).toEqual({ phone: null, email: null, address: null });
  });

  it('still rejects an email that is not one', () => {
    expect(updateTenantSchema.safeParse({ settings: { contact: { email: 'nope' } } }).success).toBe(false);
  });

  it('keeps a real value, trimmed', () => {
    const parsed = updateTenantSchema.parse({ settings: { contact: { email: ' hola@tienda.cu ', phone: '+53 42 215566' } } });
    expect(parsed.settings?.contact).toEqual({ email: 'hola@tienda.cu', phone: '+53 42 215566' });
  });

  it('leaves a field alone when it is not sent', () => {
    expect(updateTenantSchema.parse({ settings: { contact: {} } }).settings?.contact).toEqual({});
  });
});
