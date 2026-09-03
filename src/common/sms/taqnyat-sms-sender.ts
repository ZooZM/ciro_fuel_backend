import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsSender } from './sms-sender.port';

/** Bounded so a provider that stops responding cannot hold a request open. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Taqnyat (taqnyat.sa) — the procured Saudi SMS provider.
 *
 * POST {endpoint}
 *   Authorization: Bearer {SMS_API_KEY}
 *   { "recipients": [9665xxxxxxxx], "body": "...", "sender": "ciro" }
 *
 * The port's contract is that a send either happened or throws — never a
 * quiet failure, because the caller maps a throw to SMS_SEND_FAILED
 * (FR-035f) and a swallowed error would report a code as sent when no code
 * exists. Two distinct failures are checked here, and the second is the one
 * that is easy to miss.
 */
@Injectable()
export class TaqnyatSmsSender implements SmsSender {
  private readonly logger = new Logger('TaqnyatSmsSender');

  constructor(private readonly config: ConfigService) {}

  async send(phone: string, message: string): Promise<void> {
    const endpoint = this.config.get<string>('sms.endpointUrl') ?? '';
    const token = this.config.get<string>('sms.apiKey') ?? '';
    const sender = this.config.get<string>('sms.senderId') ?? '';

    const recipient = TaqnyatSmsSender.toInternational(phone);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        // Taqnyat's documented shape: recipients is an array of numbers with
        // no '+' and no leading '00'.
        body: JSON.stringify({ recipients: [Number(recipient)], body: message, sender }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network failure or timeout — no confirmation, so it counts as not sent.
      throw new Error(
        `Taqnyat request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const payload: unknown = await response.json().catch(() => ({}));

    if (!response.ok) {
      // 401 = bad token, 400 = sender name not active on the account.
      throw new Error(
        `Taqnyat rejected the request (HTTP ${response.status})${TaqnyatSmsSender.reason(payload)}`,
      );
    }

    // ⚠ A 201 does NOT mean the message was accepted. Taqnyat returns 201 with
    // the number listed under `rejected` when it refuses that specific
    // recipient — an invalid number, a blocked prefix, insufficient balance.
    // Treating 201 as success is the bug that produces "the platform says the
    // code was sent and the driver never receives one".
    if (TaqnyatSmsSender.wasRejected(payload)) {
      throw new Error(`Taqnyat accepted the request but rejected the recipient`);
    }

    // The message body is NEVER logged — it carries the verification code
    // (FR-035g). Only the provider's own identifier is recorded, which is what
    // a support question ("was it sent?") actually needs.
    this.logger.log(`sent messageId=${TaqnyatSmsSender.messageId(payload)}`);
  }

  /**
   * Taqnyat wants a bare international number: no '+', no leading '00'.
   *
   * ONLY the Saudi local mobile form ('05XXXXXXXX') is expanded, and the
   * narrowness is the point. An earlier version expanded ANY leading zero to
   * 966, which silently turned an Egyptian '010…' into '966010…' — a
   * well-formed Saudi number belonging to nobody. The provider would accept
   * it, the platform would report the code as sent, and it would arrive
   * nowhere. A number that cannot be interpreted is left as entered so the
   * provider rejects it and this class throws, which is the loud failure.
   */
  private static toInternational(phone: string): string {
    let digits = phone.replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (/^05\d{8}$/.test(digits)) digits = `966${digits.slice(1)}`;
    return digits;
  }

  /** `rejected` arrives as a stringified array: "[]" when nothing was refused. */
  private static wasRejected(payload: unknown): boolean {
    const raw = (payload as { rejected?: unknown })?.rejected;
    if (raw == null) return false;
    return String(raw).replace(/[[\],\s]/g, '').length > 0;
  }

  private static messageId(payload: unknown): string {
    return String((payload as { messageId?: unknown })?.messageId ?? 'unknown');
  }

  private static reason(payload: unknown): string {
    const m = (payload as { message?: unknown })?.message;
    return m ? `: ${String(m)}` : '';
  }
}
