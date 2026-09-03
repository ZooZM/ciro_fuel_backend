/** spec 013 T219/FR-097 — an exchange request's own lifecycle, distinct from any order
 * status: acceptance creates no order, delivery or invoice (FR-086a). */
export enum ExchangeRequestState {
  AWAITING_RESPONSE = 'AWAITING_RESPONSE',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  WITHDRAWN = 'WITHDRAWN',
}
