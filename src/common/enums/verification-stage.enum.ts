// spec 008 (research R7): which step a verification attempt is against.
// Derived server-side from the order's own status — never accepted as a
// field on the incoming request, so the client cannot assert which
// transition it is attempting.
export enum VerificationStage {
  DEPARTURE = 'DEPARTURE',
  LOADING = 'LOADING',
}
