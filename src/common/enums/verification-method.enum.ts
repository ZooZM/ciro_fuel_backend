// spec 008 FR-036c: which credential verified a stage — a tapped NFC card
// or a scanned QR code — so the operator can tell a stronger proof from a
// weaker one after the fact. Never client-supplied as an assertion of
// success; only ever recorded alongside the platform's own decision.
export enum VerificationMethod {
  NFC_CARD = 'NFC_CARD',
  QR_CODE = 'QR_CODE',
}
