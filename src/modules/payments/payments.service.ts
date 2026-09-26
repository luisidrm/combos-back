import { ManualTransferProvider } from './providers/manual-transfer.provider.js';
import { TropiPayProvider } from './providers/tropipay.provider.js';
import type { PaymentProvider } from './payments.provider.js';

const providers: Record<string, PaymentProvider> = {
  tropipay: new TropiPayProvider(),
  manual: new ManualTransferProvider(),
};

function getProvider(name: keyof typeof providers): PaymentProvider {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown payment provider "${name}"`);
  }
  return provider;
}

// The only public surface other modules (orders) may depend on. orders
// calls this — never TropiPayProvider or ManualTransferProvider directly —
// so order logic never references a specific provider (CLAUDE.md section 6).
export const paymentsService = { getProvider };
