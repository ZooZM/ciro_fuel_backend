# Research: Transport Admin Dashboard — Live Order Lifecycle

**Feature**: 009 | **Date**: 2026-08-26 | **Phase**: 0

Every decision below was taken against the code as it stands, not against the project's context
notes — two of which proved stale during specification and a third of which proved stale here.
Where a finding contradicts a note, the code is recorded as the truth.

---

## The situation, corrected

The specification was written believing the dashboard's transport screens were mock-ups awaiting
live data. That is true, but it is not the deepest problem. Three findings, in ascending order of
severity, reframe the work:

1. The transporter's own two actions (candidate list, assignment) are missing from the dashboard's
   address list, which instead holds actions the role is forbidden to perform.
2. The dashboard's vocabulary — order stages, roles — predates two platform revisions.
3. **No transportation administrator can sign in to the dashboard at all.** Every transport screen
   is reached today through a demonstration bypass that fabricates a session.

The third finding governs the plan's sequencing: nothing in this feature is verifiable until a
real transport administrator can hold a real session.

---

## R1 — The role vocabulary predates the platform's role split

**Finding**: `src/constants/roles.ts` defines `SUPER_ADMIN`, `COMPANY_ADMIN`, `CLIENT`, `DRIVER`.
The platform split `COMPANY_ADMIN` into `FUEL_COMPANY_ADMIN` and `TRANSPORT_COMPANY_ADMIN` two
revisions ago. Neither successor exists in the dashboard.

The consequences compound:

- `DASHBOARD_LOGIN_ROLES` admits only `SUPER_ADMIN` and `COMPANY_ADMIN`, and
  `bootstrap-session.ts` clears any session whose role is not in that list. A genuine
  `TRANSPORT_COMPANY_ADMIN` token is therefore **discarded at boot**.
- `router.tsx` guards `/transport` with `[COMPANY_ADMIN, DRIVER, SUPER_ADMIN]` — a role list that
  admits a driver to the transporter's administration screens and excludes the transporter.
- `/petrolCompany` is guarded with `[CLIENT, COMPANY_ADMIN]`, admitting a customer to a fuel
  company's administration screens.

**Decision**: Replace the role vocabulary with the platform's five roles as the feature's first
change. Re-derive every route guard from the role that owns the surface: `/transport` becomes
`TRANSPORT_COMPANY_ADMIN` (plus `SUPER_ADMIN`, who is exempt from tenant isolation by design),
`/petrolCompany` becomes `FUEL_COMPANY_ADMIN`, `/admin` stays `SUPER_ADMIN`.

**Rationale**: This is Constitution Principle I (no magic values — roles must be named constants
that mean what the platform means) and Principle II (authorization is the server's to decide;
the client's role list exists to render the right navigation, and a wrong one renders the wrong
surface to the wrong person). It is also simply the precondition for signing in.

**Alternatives rejected**: Mapping `COMPANY_ADMIN` onto `TRANSPORT_COMPANY_ADMIN` as an alias —
it preserves the ambiguity that put a client on a fuel company's screens, and the alias would
have to be unwound the moment the fuel company dashboard is built.

---

## R2 — The dashboard cannot authenticate; it fabricates sessions

**Finding**: `RoleSelectionPage.tsx` is a role picker that calls `setSession(...)` with a
hand-written user object and the literal token `'dummy-token'`, then navigates into the chosen
dashboard. `bootstrapSession()` explicitly honours this:

```ts
if (accessToken === 'dummy-token' && existingUser) { setSession(existingUser, accessToken); return; }
```

So every transport screen has only ever been viewed under a fabricated session. A real login page
and a real `/auth/me` path exist alongside it, unused for this purpose.

**A second, independent break**: `api.client.ts` is configured `withCredentials: true` and calls
`POST /auth/refresh` with **no body**, expecting the platform to read an httpOnly cookie. The
platform's `AuthController.refresh` takes the refresh token **in the request body**
(`RefreshTokenDto`). The cookie the dashboard relies on is never issued. Silent refresh therefore
cannot work, and FR-064's session-lapse behaviour is unimplementable as things stand. The
project's notes flag an intended backend change to issue the cookie; it was never made.

**Decision**: Slice 0 delivers a real authenticated session for a transport administrator:
genuine credential login, `/auth/me` establishing the session, the demonstration bypass deleted,
and the refresh contract made consistent end to end.

For the refresh contract, **carry the refresh token in the request body from the dashboard**,
matching the platform as it actually behaves.

**A second, independent defect surfaced while tracing this**: `lib/auth/token-store.ts` carries a
comment claiming the access token is "in-memory only — never written to localStorage", directly
above code that reads and writes `localStorage` on every call. It is not in memory today, contrary
to both the comment and the dashboard's binding constraint. Since Slice 0 rewrites this file
regardless (`bootstrapSession`, the login flow), the fix costs nothing extra: **both** the access
token and the refresh token become genuinely in-memory for the life of the tab, restored on reload
only via `bootstrapSession`'s silent-refresh call — never via a value read back out of storage.

**Rationale**: The httpOnly-cookie design is the better one and remains the right destination —
but it is a platform-wide change touching the mobile clients' refresh path too, and this feature's
governing constraint is that its own scope stays provable. Matching the platform's existing
contract makes the dashboard work now, with one deliberate, recorded compromise, rather than
making a cross-persona change this feature cannot fully test. The compromise is recorded in the
plan's Complexity Tracking against Principle II, because a refresh token held where script can
reach it is weaker than one in a cookie.

**Alternatives rejected**: Changing the platform to issue an httpOnly cookie inside this feature —
it changes the refresh path for both mobile applications, which are working today, and a
regression there would strand real drivers mid-delivery. It is the correct next feature, not a
side effect of this one.

---

## R3 — The stage vocabulary is missing four of twelve stages

**Finding**: The dashboard names eight stages. The platform has twelve. Missing:
`AWAITING_ROUTING`, `ROUTED_TO_TRANSPORT`, `ASSIGNED_TO_DRIVER`, `LOADING`.

The omissions are precisely the transporter's own working range: the stage at which an order
arrives in their queue, the stage assignment produces, and the stage the driver occupies between
verification and departure. A transport dashboard that cannot express them can only display the
parts of a delivery that happen before it is theirs and after it has left.

**Decision**: Complete the stage vocabulary, and drive every stage-dependent rendering from an
exhaustive mapping so that an unrecognised value is a visible "unknown" rather than a blank
(FR-011).

**Rationale**: Principle I. The stage set is the domain's central enumeration; a partial copy of
it is the magic-value problem in its most damaging form.

---

## R4 — Live updates: what the platform already emits, and to whom

**Finding**, from `RealtimeGatewayService` and `OrderStateService`:

| Event | Emitted to | Trigger |
|---|---|---|
| `order:status` | `order:{orderId}` room, **and** `user:{driverId}` | every stage change |
| `order:location` | `order:{orderId}` room | driver position update |
| `order:otp` | `user:{clientId}` | handover code issued |
| `notification:new` | `user:{userId}` | any notification |
| `session:revoked` | `user:{userId}` | session revocation |

Joining `order:{orderId}` requires calling `order:watch`, which **refuses any order not in
`IN_TRANSIT` or `UNLOADING`** with `NOT_TRACKABLE`, and refuses drivers outright. A transport
administrator is otherwise admitted, and the order lookup inside the handler runs under tenant
context, so cross-company watching is already impossible.

The consequence: **a transport administrator cannot receive `order:status` for the transitions
that matter most to them** — assignment into loading, loading into transit — because they cannot
join the room until the order is already in transit. There is no user-room emission for their role
as there is for the driver's.

**Decision**: Accept this, and let the clarified hybrid absorb it. Stage changes reach the
dashboard by the detail/list refresh, which the 15-second bound already satisfies. The live
connection is used for exactly what refresh serves badly — the moving truck's position — and is
opened only while a tracking screen is open on a trackable delivery.

`order:watch`'s `NOT_TRACKABLE` refusal is adopted directly as FR-017's implementation: the screen
does not decide trackability, it reports what the platform said.

**Rationale**: This is the cheapest arrangement that meets both bounds, which is the governing
constraint. Adding a transport-admin user-room emission would be a platform change earning
nothing that polling does not already deliver within the required freshness.

**Alternatives rejected**: Emitting `order:status` into a `company:{transportCompanyId}` room —
justified only if the freshness bound were tighter than refresh can serve. It is not. Recorded as
the natural extension if that bound ever tightens.

---

## R5 — Reading a physical card: two input paths, one screen

**Finding**: The platform binds a card by its identifier (`PairCardDto.nfcCardUid`, a plain
string) and separately issues, rotates and revokes a scannable credential. The driver's mobile
application already reads cards natively. The dashboard must capture an identifier from an
operator's machine, where two mechanisms exist and behave nothing alike:

- **A reader presenting as a keyboard.** Types the identifier as keystrokes wherever focus
  happens to be, typically ending with a newline. Always available, no permission, no secure
  context, works in any browser. Its danger is precisely its mechanism: it types into whatever is
  focused, including a field on an unrelated screen.
- **The device reading the card itself.** Available only in some browsers, requires a secure
  context and a deliberate user gesture, and delivers the identifier through an explicit
  subscription rather than as keystrokes. Cleaner when present; frequently absent.

**Decision**: One pairing surface accepting both, with the keyboard-style reader as the path that
is never absent.

- Capture keystrokes at the pairing screen's level rather than in a focused input, so the operator
  need not click first (FR-045). Discriminate a reader from a person by **inter-keystroke timing
  plus a terminating newline**: a burst of characters at machine speed is a scan; anything slower
  is a person typing, and a person's entry must be submitted deliberately (FR-047).
- Feature-detect the device-reader path and subscribe only when present, never asking the operator
  which to use (FR-046).
- Both paths converge on one captured-identifier state, which is **shown for confirmation before
  binding** (FR-049) — this also makes a double-read harmless, since a second read replaces the
  pending value rather than binding twice.
- **Capture is armed only while the pairing screen is mounted and awaiting a card** (FR-048), and
  disarmed on unmount. This is what stops a stray card read from being typed into an unrelated
  form.
- The identifier is held in component state for the duration of the pairing and never logged
  (FR-051).

**Rationale**: The keyboard path is the one that always works and therefore the one whose absence
would break the feature; the device path is a convenience layered on top. Arming capture only on
the pairing screen turns the keyboard wedge's chief hazard into a non-issue by construction rather
than by operator discipline.

**Alternatives rejected**: A focused text input as the only capture point — it requires the
operator to click before presenting a card, which is exactly the friction the reader exists to
remove, and it does not prevent a stray read landing in some other field on some other screen.
Requiring the operator to declare which reader they have — it is a question the screen can answer
itself, and getting it wrong strands them.

---

## R6 — Totals a cursor cannot give

**Finding**: The platform's order list is cursor-paginated and returns `{ items, nextCursor }`.
The dashboard's type declares `{ items, total, page }` — a shape the platform does not produce,
so the existing list code could not have worked against it. Story 6's overview needs totals per
stage, which a cursor page cannot yield.

Critically, the multi-party isolation plugin scopes **`countDocuments` and `count`** alongside the
read operations. A count therefore carries the acting administrator's `fuelCompanyId` and
`transportCompanyId` automatically, with no hand-written filter.

**Decision**: Correct the dashboard's paged-response type to the platform's cursor shape, and add
one **summary endpoint** to the platform returning every overview figure in a single response,
computed from scoped counts.

**Rationale**: Principle II — the figures inherit isolation structurally, from the same global
mechanism that protects the lists, rather than from a filter someone remembered to write. One
request per dashboard open (FR-058) is also the cheapest possible answer to the cost constraint,
against a naive alternative that would page entire collections to count them.

**Alternatives rejected**: Adding `total` to the list response — it makes every page of every
list pay for a count that only one screen wants. Counting client-side from the first page — it
produces numbers that are wrong, which is worse than absent.

---

## R7 — What the platform already provides, and the one thing it does not

Verified present and requiring **no platform change**: candidate listing with suggested truck ·
assignment of driver, truck and tank in one transaction with capacity and grade guards ·
verification override and vehicle reassignment · truck and tank management including card pairing
and the credential lifecycle · driver management · order stage history including verification
records · tenant isolation across all of it.

Verified **absent** and required: the overview summary endpoint (R6).

**Decision**: Treat the platform as complete but for R6. Any further gap discovered during wiring
is a finding to be recorded, not a licence to redesign.

**Rationale**: The project's notes twice described built work as unbuilt. The corresponding risk
in the other direction — assuming something exists because a note says so — is guarded by having
read the controllers directly.

---

## R8 — Sequencing: what must land alone, and why

The feature is large (76 requirements, two repositories, one shared walkthrough). Three changes
are invisible when wrong and must land alone with the suites green.

| Slice | Content | Why alone |
|---|---|---|
| **0** | Role vocabulary, real login, refresh contract, demo bypass removed | Every other slice is unverifiable until a real session exists. It also changes route guards for personas this feature does not otherwise touch. |
| **1** | Stage vocabulary completed; paged-response shape corrected | Touches every screen that names a stage, across all three personas' surfaces. A mistake here misreports deliveries rather than failing visibly. |
| **2** | Assignment: candidates, driver/truck/tank selection, guards, refusals | The break in the chain. First slice delivering user-visible value. |
| **3** | Delivery progress and tracking, including the live position connection | Depends on 1 for stage names, 2 for something to track. |
| **4** | Fleet: trucks, tanks, card pairing, credential lifecycle, drivers | Independent of 2 and 3; large enough to sequence separately. |
| **5** | Stalled deliveries: override, reassignment | Small, depends on 3's detail view. |
| **6** | Overview summary endpoint and dashboard home | Last, and the strongest proof the earlier slices are live. |
| **7** | The walkthrough, its seed data, and the automated suites | Spans everything; written as the slices land, run whole at the end. |

**Decision**: Slices 0 and 1 land alone. Slices 2–6 may overlap where they touch disjoint screens.
Slice 7's walkthrough document is begun at slice 2 and grows with each subsequent slice, so it is
never written from memory.

**Rationale**: The two slices that land alone are the two whose failure mode is silent. The rest
fail visibly on the screen they belong to.

---

## Resolved unknowns

| Unknown | Resolution |
|---|---|
| Update mechanism and its cost | R4 — refresh for stages and lists, live connection for position only |
| Cross-repo tracking | Specification governs both; dashboard carries a branch and a pointer |
| Walkthrough form | Manual procedure, plus platform-level lifecycle test, plus browser coverage of assignment and tracking |
| Fuel company's steps | Scripted against the real interface under that role |
| Notification vocabulary | Verified already in agreement; confirmed by observation during the walkthrough |
| Pagination and totals | R6 — cursor everywhere, one summary endpoint |
| Language scope | New and rebuilt screens fully bilingual and correct in both directions |
| Card capture mechanics | R5 — two paths, keyboard-style always available, capture armed only while pairing |
| Role vocabulary and sign-in | R1, R2 — the feature's true starting point |

No unknowns remain.
