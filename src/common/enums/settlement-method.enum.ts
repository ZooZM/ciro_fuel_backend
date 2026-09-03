/** spec 013 T141/FR-066 — how a company pays the platform. Distinct from
 * `PaymentMethod` (how a CLIENT pays for an order) — this is the settlement channel a
 * fuel/transport company uses to pay the platform itself. */
export enum SettlementMethod {
  BANK_TRANSFER = 'BANK_TRANSFER',
  NATIONAL_PAYMENT_SERVICE = 'NATIONAL_PAYMENT_SERVICE',
}
