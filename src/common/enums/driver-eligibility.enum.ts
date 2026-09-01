// spec 010 FR-002/FR-004: a computed classification, never stored on `User` —
// derived at read time in `DispatchService` from `isActive`/`isOnline`/
// `isAvailable`/`activeOrderId`. Four values, not a boolean "eligible/not":
// the two ineligible-but-selectable-with-a-reason states (offline vs.
// already committed) must be shown distinctly (FR-004), and INACTIVE is a
// separate, never-selectable-at-all state — a suspended/deactivated driver
// is still shown (spec Edge Cases: "the candidate list still shows them...
// but none are selectable"), which is neither BUSY nor OFFLINE.
export enum DriverEligibility {
  ELIGIBLE = 'ELIGIBLE',
  BUSY = 'BUSY',
  OFFLINE = 'OFFLINE',
  INACTIVE = 'INACTIVE',
}
