# Feature Specification: Web Admin Dashboard (Super Admin & Company Admin)

**Feature Branch**: `003-web-admin-dashboard`

**Created**: 2026-07-20

**Status**: Draft

**Input**: User description: "Initialize the React web dashboard for the Multi-Tenant B2B Fuel Delivery SaaS. The dashboard serves two completely isolated personas — SUPER_ADMIN (platform owner) and COMPANY_ADMIN (fuel-logistics tenant admin) — with strict role-based access control, secure session handling, and a feature-based structure."

## Clarifications

### Session 2026-07-20

- Q: Should the dashboard be bilingual with right-to-left support? → A: Bilingual Arabic + English with full RTL, user-switchable, built in from day 1 (hard requirement for the Saudi B2B market).
- Q: Does the Company Admin manage company settings and base fuel pricing in this dashboard? → A: Yes — a dedicated Settings area for the company profile and the base price per fuel type (e.g., 91, 95, 98, Diesel), linked to the backend.
- Q: How do order views reflect live status changes? → A: Periodic polling / auto-refresh on an interval (near-real-time); no Socket.io dependency for the dashboard in v1.
- Q: Where are session credentials held for restart persistence vs. XSS safety? → A: Access token kept in memory; refresh token issued only as an httpOnly, Secure, SameSite=Strict cookie. Silent refresh on app load restores the session; the access token is never persisted to JS-readable storage.
- Q: Does Super Admin onboarding include creating the tenant's first Company Admin? → A: Yes — onboarding provisions the company and its initial Company Admin account atomically in one flow, returning/delivering initial secure credentials for that admin to sign in.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Company Admin Manages Their Tenant Operations (Priority: P1)

A fuel-logistics company administrator signs in to the web dashboard and lands in a workspace scoped entirely to their own company. From there they review incoming fuel orders, approve or reject pending orders (adjusting the estimated price to a binding final price where needed), manage their company's drivers and clients, and monitor active deliveries — all without ever seeing another company's data.

**Why this priority**: The Company Admin is the primary daily operator of the platform. Order approval and driver/client management are the revenue-critical actions the dashboard exists to serve; without this persona working, the platform has no operational front end.

**Independent Test**: Sign in as a Company Admin, confirm the workspace shows only that company's orders/drivers/clients, approve a pending order by setting a final price, and verify the change is reflected — with no cross-tenant record ever visible or reachable.

**Acceptance Scenarios**:

1. **Given** a signed-in Company Admin, **When** they open the orders view, **Then** only their own company's orders are listed, each showing current lifecycle status.
2. **Given** an order in "Pending Approval", **When** the admin adjusts the estimated price and approves it, **Then** the order moves to "Approved" with the final price recorded and the client notified (state transition confirmed by the backend, not asserted locally).
3. **Given** a Company Admin, **When** they open the drivers or clients view, **Then** they can create, view, and manage only users belonging to their own company.
4. **Given** a Company Admin, **When** they attempt to reach any Super-Admin-only area (e.g., cross-company administration) by any means including a direct URL, **Then** access is denied and they are redirected to a safe in-scope location or shown a 403/404.

---

### User Story 2 - Super Admin Administers the Platform Across All Tenants (Priority: P1)

The platform owner signs in and gains cross-company visibility. They onboard new fuel-logistics companies, activate or suspend existing tenants, and review platform-wide activity. Their view is deliberately broader than any single tenant and is unavailable to Company Admins.

**Why this priority**: Tenant onboarding and suspension are the platform-governance actions that make the SaaS multi-tenant. This persona must be strictly separated from tenant admins, so its access boundary is as critical as the tenant persona itself.

**Independent Test**: Sign in as a Super Admin, verify visibility across multiple companies, onboard a new company and suspend an existing one, and confirm a Company Admin token cannot reach any of these Super-Admin views.

**Acceptance Scenarios**:

1. **Given** a signed-in Super Admin, **When** they open the companies view, **Then** all tenant companies are listed with their active/suspended status.
2. **Given** a Super Admin, **When** they onboard a new company, **Then** the company and its initial Company Admin account are created together (atomically) and the initial admin credentials are surfaced or delivered so that admin can sign in.
3. **Given** a Super Admin, **When** they suspend an existing company, **Then** the change is confirmed by the backend and reflected in the list.
4. **Given** a Company Admin session, **When** it attempts to load any Super-Admin route, **Then** the route guard blocks it before any tenant-crossing data is requested or rendered.

---

### User Story 3 - Secure, Persistent, Auto-Refreshing Session (Priority: P1)

Any authorized admin signs in once and works uninterrupted for the length of a normal shift. Their session survives page reloads, silently renews expiring access without forcing a re-login mid-task, and is terminated cleanly — with immediate loss of access — when their credentials become invalid or they sign out.

**Why this priority**: A dashboard that drops sessions on every reload, or that keeps working after credentials are revoked, is both unusable and unsafe. Reliable, secure session handling underpins both personas and every protected action.

**Independent Test**: Sign in, reload the page and confirm the session persists; let the access credential expire and confirm a protected request succeeds via silent renewal without a visible re-login; then simulate a revoked/failed renewal and confirm the user is logged out and pushed to sign-in with no protected data left on screen.

**Acceptance Scenarios**:

1. **Given** a signed-in admin, **When** they reload the browser, **Then** they remain signed in and land on their role-appropriate workspace.
2. **Given** an in-flight protected request whose access credential has expired, **When** the credential is silently renewed, **Then** the original request completes without the user seeing a re-login prompt.
3. **Given** several protected requests failing with an expired credential at once, **When** renewal occurs, **Then** the credential is renewed a single time and the queued requests all proceed (no renewal storm).
4. **Given** a session whose renewal fails or whose credentials are revoked, **When** any protected request is attempted, **Then** the session is cleared, the user is redirected to sign-in, and no stale protected data remains visible.

---

### Edge Cases

- **Wrong-role deep link**: A Company Admin opens a bookmarked Super-Admin URL — the route guard denies access before any out-of-scope data is fetched.
- **Unauthenticated deep link**: A signed-out user opens a protected URL — they are redirected to sign-in and returned to the original destination after a successful login.
- **Suspended tenant**: A Company Admin whose company was suspended by a Super Admin attempts to sign in — access is refused with the **same generic sign-in failure message** used for any invalid credential (the backend deliberately does not disclose suspension, deactivation, or bad credentials separately, to prevent account enumeration). If the admin was already signed in when the suspension took effect, their next protected request fails authentication and the session is cleared per FR-009.
- **Concurrent credential expiry**: Multiple simultaneous requests hit an expired credential — only one renewal occurs and all requests resume.
- **Backend-rejected transition**: An admin approves an order that the backend rejects (already handled elsewhere, or invalid state) — the dashboard surfaces the backend result and does not show a locally-assumed success.
- **Untrusted dynamic content**: Tenant- or user-supplied text (company names, notes, addresses) is rendered without executing any embedded markup or script.
- **Hard forbidden response**: A protected request returns a forbidden result for a genuinely out-of-scope resource — the dashboard treats it as an access boundary, not a session error, and does not loop on renewal.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The dashboard MUST authenticate administrators and support exactly two personas — Super Admin (platform owner) and Company Admin (tenant admin) — with no other roles able to sign in to this surface.
- **FR-002**: The dashboard MUST scope every Company Admin's view strictly to their own company's data; no interface path may list, display, or confirm the existence of another company's records.
- **FR-003**: The dashboard MUST grant Super Admins cross-company visibility and platform-governance actions (company onboarding, activation/suspension) that are never available to Company Admins.
- **FR-004**: The dashboard MUST guard every route by the authenticated user's role, denying access to out-of-role routes before any out-of-scope data is requested or rendered, and redirecting or showing a forbidden/not-found result.
- **FR-005**: The dashboard MUST redirect unauthenticated users away from protected routes to sign-in, preserving their intended destination for post-login return.
- **FR-006**: The dashboard MUST attach the authenticated session credential to every backend request automatically, without per-call handling by feature code.
- **FR-007**: The dashboard MUST detect an expired access credential on a protected request and silently renew it once, transparently retrying the affected request(s) without a user-visible re-login.
- **FR-008**: Extending FR-007 to the concurrent case, the dashboard MUST coalesce simultaneous renewals (single-flight): multiple in-flight requests that all fail on the same expired credential MUST trigger exactly one renewal, after which every queued request proceeds with the new credential. (FR-007 governs the single-request retry semantics; FR-008 governs concurrency deduplication.)
- **FR-009**: The dashboard MUST terminate the session — clearing stored credentials, redirecting to sign-in, and removing protected data from view — when renewal fails or credentials are revoked.
- **FR-010**: The dashboard MUST distinguish an authentication failure (expired/invalid credential → renew or log out) from an authorization denial for an out-of-scope resource (→ treat as access boundary, no renewal loop).
- **FR-011**: The dashboard MUST persist the session across page reloads and browser restarts within the session's valid lifetime, restoring the user to their role-appropriate workspace via a silent renewal on app load — without persisting the access credential to any JavaScript-readable storage.
- **FR-011a**: The short-lived access credential MUST be held only in volatile in-memory application state; the long-lived renewal credential MUST be held only in an httpOnly, Secure, SameSite=Strict cookie that application code cannot read, so a script-injection flaw cannot exfiltrate either long-lived credential.
- **FR-012**: A Company Admin MUST be able to list and review their company's fuel orders with current lifecycle status.
- **FR-012a**: Active order lists and order-detail views MUST auto-refresh on a periodic interval so status changes driven elsewhere (mobile clients/drivers) appear without a manual reload; real-time socket streaming is out of scope for v1.
- **FR-013**: A Company Admin MUST be able to approve or reject a pending order, adjusting the estimated price to set the binding final price on approval.
- **FR-014**: A Company Admin MUST be able to manage (create, view, update status of) their company's drivers and clients.
- **FR-014a**: A Company Admin MUST be able to view and edit their own company profile via a dedicated Settings area.
- **FR-014b**: A Company Admin MUST be able to set and update the base price per fuel type (e.g., 91, 95, 98, Diesel) for their company, since order estimated prices are derived from these base rates.
- **FR-015**: A Super Admin MUST be able to list all tenant companies and onboard, activate, or suspend them.
- **FR-015a**: Onboarding a company MUST provision the company and its initial Company Admin account as a single atomic operation (neither is created without the other), and MUST surface or deliver the initial secure credentials for that admin to sign in for the first time.
- **FR-016**: The dashboard MUST treat the backend as the sole source of truth for every order and tenant state transition, reflecting the backend-confirmed result rather than asserting an outcome locally.
- **FR-017**: The dashboard MUST render all dynamic, user- or tenant-supplied content without executing any embedded markup or scripts (no injection of active content).
- **FR-018**: The dashboard MUST provide a clear sign-out action that fully clears the session and returns the user to sign-in.
- **FR-019**: The dashboard MUST present accurate, non-technical feedback when an action is denied, fails, or is rejected by the backend, without leaking internal error detail.
- **FR-020**: The dashboard MUST be organized so each functional area (authentication, orders, companies, drivers, clients) is self-contained, keeping personas and their capabilities cleanly separated.
- **FR-021**: The dashboard MUST support Arabic and English with a user-switchable language, defaulting to Arabic, and MUST render the entire interface right-to-left when Arabic is active and left-to-right when English is active (layout, alignment, iconography, and directional controls all mirror correctly).
- **FR-022**: All user-facing text MUST be sourced from localizable resources (no hard-coded display strings), and locale-sensitive values (dates, times, numbers, currency) MUST render according to the active language.

### Key Entities *(include if feature involves data)*

- **Admin User (session principal)**: The signed-in administrator. Key attributes: identity, role (Super Admin or Company Admin), and — for Company Admins — the owning company. Drives every access decision.
- **Company (Tenant)**: A fuel-logistics tenant. Key attributes: identity, profile details, active/suspended status. The isolation boundary for all Company-Admin-visible data; the governed object for Super Admins.
- **Fuel Base Price**: A per-company, per-fuel-type base rate (e.g., 91, 95, 98, Diesel) maintained by the Company Admin in Settings. The source value from which order estimated prices are derived.
- **Order**: A fuel delivery request within a company. Key attributes: lifecycle status, estimated price, final price. Reviewed and approved/rejected by Company Admins.
- **Driver**: A delivery operator belonging to a company. Managed by that company's admin.
- **Client**: A fuel station operator belonging to a company. Managed by that company's admin.
- **Session Credential**: The proof-of-identity attached to backend requests, subject to expiry, silent renewal, and revocation. Never the source of truth for authorization decisions on its own.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of attempts by a Company Admin to reach a Super-Admin-only area — via navigation, direct URL, or bookmark — are blocked with no out-of-scope data rendered.
- **SC-002**: In 0 cases does a Company Admin's workspace display, list, or confirm the existence of another company's records.
- **SC-003**: A signed-in admin retains their session across a page reload in at least 99% of reloads within the session's valid lifetime, with no unexpected re-login.
- **SC-004**: When an access credential expires mid-session, the affected request completes via silent renewal without a visible re-login in at least 99% of cases, and renewal occurs exactly once even under concurrent expiry.
- **SC-005**: When credentials are revoked or renewal fails, the user is signed out and all protected data is cleared from view within 2 seconds of the next protected request.
- **SC-006**: A Company Admin can locate and approve a pending order (setting the final price) in under 60 seconds from landing on their workspace.
- **SC-007**: A Super Admin can onboard a new company or change a company's active/suspended status in under 90 seconds.
- **SC-008**: 0 instances of user- or tenant-supplied content executing embedded active content (script/markup injection) across the dashboard.
- **SC-009**: Switching the language between Arabic and English flips the entire interface direction (RTL↔LTR) with no untranslated strings and no broken/mis-mirrored layout on any dashboard screen.
- **SC-010**: Every interactive control is keyboard-operable and screen-reader-labeled, and an automated accessibility check reports 0 critical violations on every dashboard screen in both RTL and LTR.

## Assumptions

- The dashboard consumes the existing feature-001 backend platform (REST `/api/v1`, JWT-based auth with an `/auth/refresh` renewal endpoint, tenant isolation enforced server-side); it does not introduce its own persistence or authorization authority.
- Super Admin and Company Admin accounts are provisioned through existing platform processes (e.g., Super Admin onboards companies and their first admin); self-service admin registration is out of scope for this initial dashboard.
- The two mobile-only personas (Client and Driver) are served by the feature-002 mobile app and do not sign in to this web dashboard; the dashboard only *manages* those users, it is not their client.
- Session credentials are held only for the browser session's valid lifetime and are cleared on sign-out, renewal failure, or revocation; a dedicated app-lock/idle-timeout beyond credential expiry is out of scope for v1.
- Real-time live-tracking of in-progress deliveries (Socket.io `/tracking`) may be surfaced later; the initial dashboard scope is management and administration views, not live map tracking.
- Standard modern-browser, desktop-first B2B usage is assumed (stable connectivity, current evergreen browsers); offline operation is out of scope.
- Backend remains the source of truth for every order and tenant transition; the dashboard never locally asserts a lifecycle outcome the backend has not confirmed.
