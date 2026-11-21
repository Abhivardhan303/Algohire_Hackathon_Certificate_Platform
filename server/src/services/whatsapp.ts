import { env } from '../config/env';

export class WhatsAppError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'WhatsAppError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * SIMULATED WhatsApp provider - no real WhatsApp integration.
 *
 * mixed mode rules (phone last digit):
 *   7 -> permanent failure (non-retryable)
 *   8 -> timeout on every attempt (retryable, exhausts retries)
 *   9 -> temporary failure on attempt 1, succeeds afterwards
 *   other -> success
 */
export async function sendWhatsAppMessage(params: {
  phone: string;
  message: string;
  attempt: number;
}): Promise<string> {
  const { phone, attempt } = params;
  await sleep(120);

  const mode = env.WHATSAPP_MODE;
  const lastDigit = phone.replace(/\D/g, '').slice(-1);

  if (mode === 'success') return providerRef();
  if (mode === 'failure') {
    throw new WhatsAppError('Simulated permanent WhatsApp failure (WHATSAPP_MODE=failure)', false, 'PERMANENT_FAILURE');
  }
  if (mode === 'timeout') {
    throw new WhatsAppError('Simulated WhatsApp gateway timeout', true, 'TIMEOUT');
  }

  if (lastDigit === '7') {
    throw new WhatsAppError('Simulated permanent WhatsApp failure (number is not on WhatsApp)', false, 'PERMANENT_FAILURE');
  }
  if (lastDigit === '8') {
    throw new WhatsAppError('Simulated WhatsApp gateway timeout', true, 'TIMEOUT');
  }
  if (lastDigit === '9' && attempt <= 1) {
    throw new WhatsAppError('Simulated temporary WhatsApp failure', true, 'TEMPORARY_FAILURE');
  }
  return providerRef();
}

function providerRef(): string {
  return `wamid.SIM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
