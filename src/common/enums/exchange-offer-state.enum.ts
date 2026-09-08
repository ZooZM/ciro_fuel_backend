/**
 * spec 016 (broadcast fuel exchange) data-model.md — an `ExchangeOffer`'s own lifecycle.
 * `OPEN -> AWARDED` and `OPEN -> WITHDRAWN` are both a conditional update filtered on
 * `state: OPEN` (research R4); `CLOSED_NO_AWARD` is reached ONLY by migrating a
 * `DECLINED` directed `ExchangeRequest` (research R5) — nothing in the live flow closes
 * an offer without an award, so an unanswered offer simply stays OPEN indefinitely.
 */
export enum ExchangeOfferState {
  OPEN = 'OPEN',
  AWARDED = 'AWARDED',
  WITHDRAWN = 'WITHDRAWN',
  CLOSED_NO_AWARD = 'CLOSED_NO_AWARD',
}
