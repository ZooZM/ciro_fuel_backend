/**
 * spec 016 (broadcast fuel exchange) data-model.md — an `ExchangeProposal`'s own
 * outcome. `DECLINED` is set by the proposing company and is final for it. `AWARDED`
 * and `NOT_SELECTED` are set ONLY by the raiser's award transaction (research R4),
 * never by the proposer.
 */
export enum ProposalOutcome {
  PROPOSED = 'PROPOSED',
  DECLINED = 'DECLINED',
  AWARDED = 'AWARDED',
  NOT_SELECTED = 'NOT_SELECTED',
}
