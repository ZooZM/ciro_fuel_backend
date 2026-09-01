/** spec 005 T116/FR-039a — exactly two states, one direction: SUBMITTED ->
 * ACKNOWLEDGED. No threaded conversation, reply, or resolution workflow. */
export enum SupportRequestState {
  SUBMITTED = 'SUBMITTED',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
}
