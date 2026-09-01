export const SMS_SENDER = 'SMS_SENDER';

/**
 * The one seam between the platform and whichever SMS provider is
 * eventually procured (spec 005 research R4 — the feature's only new
 * third-party dependency, deliberately kept behind this port so nothing
 * else blocks on the provider decision). `PhoneVerificationService` is the
 * only consumer.
 *
 * Implementations MUST throw (not swallow) when the provider rejects or
 * cannot confirm the send — the caller maps that to `SMS_SEND_FAILED`
 * (FR-035f) and must never report a code as sent when it was not.
 */
export interface SmsSender {
  send(phone: string, message: string): Promise<void>;
}
