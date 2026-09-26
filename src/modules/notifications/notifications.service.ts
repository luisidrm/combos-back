import { Resend } from 'resend';
import { config } from '../../config/index.js';
import { InternalError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

const resend = new Resend(config.resendApiKey);

// The passwordless login code for buyers (CLAUDE.md section 7). Called from
// the SuperTokens email-delivery hook in core/supertokens.ts.
//
// Outside production nothing is emailed — the code goes to the log, so
// local login works without a real Resend key or a verified domain. The
// address is deliberately not logged (CLAUDE.md section 13: no PII).
async function sendLoginCode(email: string, code: string): Promise<void> {
  if (!config.isProduction) {
    logger.info({ code }, 'Login code (dev only, not emailed)');
    return;
  }

  const { error } = await resend.emails.send({
    from: config.emailFrom,
    to: email,
    subject: `Tu código de acceso / Your login code: ${code}`,
    text: [
      `Tu código de acceso es ${code}. Vence en unos minutos.`,
      `Your login code is ${code}. It expires in a few minutes.`,
      '',
      'Si no lo pediste, ignora este mensaje. / If you did not request it, ignore this message.',
    ].join('\n'),
  });
  if (error) {
    throw new InternalError(`Could not send login code email: ${error.message}`);
  }
}

// Business logic for Resend templates, wa.me deep link helpers.
// This is the ONLY public surface other modules may import (via index.ts).
export const notificationsService = { sendLoginCode };
