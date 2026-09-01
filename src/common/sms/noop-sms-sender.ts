import { Injectable, Logger } from '@nestjs/common';
import { SmsSender } from './sms-sender.port';

/**
 * Development default (`SMS_PROVIDER=none`, validation.ts rejects it in
 * production). Logs the code instead of sending it — this is what makes
 * Story 7 (phone verification) fully buildable and testable before an SMS
 * provider is procured (research R4); quickstart.md's Story 7 walkthrough
 * reads the code from this exact log line. FR-035g's "never logged" rule
 * governs the production path (never returned to the app, never in a real
 * delivery record) — it does not forbid this dev-only stand-in, which is
 * unreachable once `SMS_PROVIDER` must be a real provider in production.
 * Never throws: a developer reading a code from the log is the whole
 * point, not a failure to simulate.
 */
@Injectable()
export class NoopSmsSender implements SmsSender {
  private readonly logger = new Logger('NoopSmsSender (SMS_PROVIDER=none)');

  async send(phone: string, message: string): Promise<void> {
    this.logger.log(`Would send to ${phone}: ${message}`);
  }
}
