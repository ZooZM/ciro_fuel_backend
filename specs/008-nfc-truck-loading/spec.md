# Feature Specification: NFC Truck Verification & Warehouse Loading

**Feature Branch**: `007-driver-home-delivery` (spec 008 authored on the 007 branch by explicit request — no separate branch was cut)

**Created**: 2026-08-24

**Status**: Draft

**Input**: User description: "there is NFC cards to verify the chosen car with there driver. transportadmin: create a truck and he has a 13.56mhz rfid reader usb to assign that NFC Card to this truck. when order coming he chose the driver and truck to do the order. driver: receive the order and can't start the order until he scan the NFC card that stick on car. scan and start that he has a location of warehouse of gasoline to fill the quantity and scan again to start navigate to station"

## Overview

Today the platform cannot answer a basic operational question: **is the fuel actually on the vehicle the operator assigned?** A truck is not a thing the platform owns — it is a set of fields copied onto a driver's own account, permanently bound to that driver, with no identity of its own. Assignment picks a person, never a vehicle. And the moment a person is picked, the order is declared to be moving: there is no step between "assigned" and "in transit", no proof the driver ever reached the vehicle, and no loading stage at all — the platform has no concept of where the fuel comes from.

This feature makes the vehicle a first-class, verifiable participant in the delivery. A transportation company registers its fleet as two separate things — **trucks** (the tractors, each carrying a physical NFC card) and **tanks** (the trailers, each with a code, a material, a capacity and the grades it may carry) — and picks a driver, a truck and a tank for each order. The driver cannot begin the trip until they physically verify the truck — tapping the card fixed to it, or scanning a code their operator generated for it — proving they are at the assigned tractor. They are then routed to a fuel warehouse to load, record what was actually loaded, and verify again to confirm loading is complete; only then does navigation to the customer's station begin. Where a driver genuinely cannot reach the platform, their operator can advance the stage on their behalf — recorded as an override, never as proof.

## Clarifications

### Session 2026-08-24

- Q: When the loaded quantity differs from the ordered quantity, what happens to the invoice — which is issued at approval and, for direct-payment orders, already settled before loading? → A: The invoice is never altered. The difference accrues to a **litre balance held on the client's own account**, expressed in litres rather than money. *(Superseded in scope by two later answers in this same session: the volume comes from an Aramco invoice reconciled asynchronously, and the balance that consumes it is deferred to its own feature. The principle — the issued invoice is never rewritten — still holds here and is kept as FR-034.)*
- Q: Which party owns and registers fuel warehouses, and how is the right one chosen for an order? → A: Warehouses are **platform-level infrastructure registered by the CIRO platform operator (SUPER_ADMIN)**, who loads the full set of Saudi warehouses. They belong to neither the fuel company nor the transportation company, and are shared across all tenants.
- Q: What happens when the driver's device cannot read NFC — hardware absent or switched off? → A: The **transportation company administrator can generate a QR code that serves the same purpose as the NFC card**. The driver scans it instead of tapping, and it verifies the same truck by the same rule.
- Q: How does an order's status represent the new verification and loading stages? → A: **One new state, `LOADING`.** The lifecycle becomes `ASSIGNED_TO_DRIVER` → *[departure verification]* → `LOADING` → *[loading confirmed]* → `IN_TRANSIT` → `UNLOADING` → `DELIVERED`. `ASSIGNED_TO_DRIVER` stops advancing automatically and now means "assigned, awaiting verification"; `IN_TRANSIT` narrows to mean "loaded and travelling to the customer".
- Q: What happens when a driver cannot reach the platform to verify — e.g. no signal at the depot? → A: **Strictly online, plus an operator override.** Verification itself is never captured offline, never queued, and never decided by the device. When a driver genuinely cannot get signal, the transportation company administrator advances the stage from the dashboard as an explicitly recorded **operator override** — an attestation, not a verification, and labelled as such everywhere it appears.
- Q: How does the operator choose a driver and a truck — in what order, and how are they matched? → A: **Driver first, then truck, then tank**, with the truck pre-filled. Selecting a driver auto-suggests the exact truck that driver last operated, which the operator may accept or change. Proximity ranking stays a property of the driver, exactly as today.
- Q: Is a vehicle one entity or two? → A: **Two.** A **Truck** is the tractor/head; a **Tank** is the trailer/container it pulls. A tank carries its own unique code and a material type (e.g. iron or aluminium). The **NFC card is bound strictly to the Truck**, never to the tank — the driver verifies the tractor. The assigned tank's code and material MUST be visible to the driver on their active delivery so they know what they are hauling.
- Q: Now that a vehicle is a truck plus a tank, where do capacity and fuel-grade capability live? → A: **Both on the Tank, with grades listed explicitly.** A tank carries its code, material, maximum capacity, and the set of grades it may carry. A truck reduces to its plate, its card, and whether it is in service. The capacity and fuel-grade assignment guards validate the tank. Material is recorded as fact and does not by itself determine which grades are permitted.
- Q: How much is the driver-entered loaded quantity trusted? → A: **The driver never enters a quantity at all.** The authoritative loaded volume comes from an official Aramco invoice issued to the gas station company, uploaded later and reconciled asynchronously away from the delivery flow. The driver's app offers only a *Confirm loading complete* action — a state transition with no numeric input of any kind.
- Q: Does Aramco-invoice reconciliation, and the client litre balance it feeds, belong to this feature? → A: **No — both are deferred to their own feature.** Nothing in this feature's flow can move a balance: loading confirms with no volume and the delivery completes with none. The client litre balance (formerly US6) is removed from this spec along with invoice upload and reconciliation, which carry their own unanswered questions (who uploads, what happens when an invoice contradicts the order, who approves a correction, what if it never arrives).
- Q: How long does a generated QR code stay valid? → A: **Revocable on demand, with no automatic expiry**, so a driver who depends on it is never stranded mid-shift while a leaked code still has a direct remedy. In addition, a code MUST only be presentable through the driver app's own **live camera preview** — the app MUST NOT accept a code from a stored image, screenshot, gallery pick, file, or any external scanner.
- Q: What happens to the trucks that already exist, embedded on every driver's account? → A: **Discarded — a clean cut.** The platform is pre-production and holds only test data, so operational continuity is not a concern. The embedded per-driver truck is removed outright with no promotion or migration script, and each transportation company registers its fleet fresh. A flag day is acceptable, and no backward compatibility with trucks or deliveries created before this feature is required.

### Session 2026-08-27

- Q: The loading-stage read presents the same card, on the same truck, that departure already verified. What does it actually prove that departure did not? → A: **On its own, nothing — so it is additionally geofenced.** The card proves the truck; the driver's position at the moment of the read is what proves they reached the depot. A loading verification is accepted only when the assigned truck's credential is presented from within the assigned warehouse's radius, and refused with a distinct answer — the right truck, the wrong place — when it is not.
- Q: Which position is the geofence evaluated against — the driver's last streamed position, or a fresh fix taken with the read? → A: **A fresh fix, sent with the request.** The streamed position is throttled to 50 m / 3 minutes and is staler than that whenever the driver has been parked, which is exactly the situation at a depot gate. A geofence satisfied by an hour-old point proves the phone was near the warehouse once, which is not the claim being made.
- Q: What happens when the device cannot produce a fix at all — location off, permission refused, no signal? → A: **The attempt is refused and nothing is recorded.** It cannot be judged either way, so it is turned away on the same footing as an out-of-sequence attempt (FR-025) rather than logged as a failure the driver did not commit. The existing operator override (FR-047) remains the escape hatch when a device genuinely cannot report where it is.
- Q: How large is the radius? → A: **A configurable platform-wide distance, defaulting to 500 m.** Sized for a depot yard plus civilian GPS error rather than for a doorway: a driver who is demonstrably in the right facility should not be refused because the recorded warehouse point sits at the far gate.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A transportation company registers its fleet: trucks, tanks and cards (Priority: P1)

A transportation company administrator registers their fleet as two separate things: **trucks** (the tractors — plate number, and a physical NFC card paired by holding it to a desk-side USB reader) and **tanks** (the trailers — a unique code, what material they are made of, how much they hold, and which fuel grades they may carry).

**Why this priority**: Nothing else in this feature can exist without trucks and tanks being real, individually identifiable records. Every later story references both by identity, the verification gate has nothing to compare against until cards are paired, and the assignment guards have nothing to check until tanks carry their capacity and permitted grades.

**Independent Test**: Register three trucks and three tanks for one transportation company, pair a card with each truck, and confirm all are listed and distinguishable, that a card already paired to one truck is refused for another, and that a tank code already in use is refused. Delivers value on its own: the operator finally has a fleet inventory.

**Acceptance Scenarios**:

1. **Given** a signed-in transportation company administrator, **When** they register a truck with a plate number, **Then** the truck appears in their fleet as its own record, separate from any driver and from any tank.
2. **Given** a registered truck with no card, **When** the administrator holds an NFC card to the desk reader while the pairing field is focused, **Then** the card's identifier is captured and the truck is shown as paired.
3. **Given** a card already paired to truck A, **When** the administrator offers the same card for truck B, **Then** the platform refuses and names the conflict, leaving both trucks unchanged.
4. **Given** a signed-in administrator, **When** they register a tank with a code, a material, a capacity and its permitted fuel grades, **Then** the tank appears in their fleet as its own record, with no card of its own.
5. **Given** a tank code already in use, **When** the administrator registers another tank with the same code, **Then** the platform refuses and names the conflict.
6. **Given** a truck or tank belonging to transportation company X, **When** an administrator of company Y attempts to view or modify it, **Then** it is indistinguishable from a record that does not exist.
7. **Given** a truck whose card was damaged or lost, **When** the administrator pairs a replacement card, **Then** the new card takes effect and the old one no longer verifies that truck.

---

### User Story 2 - An operator assigns a driver, a truck and a tank (Priority: P1)

When an order reaches a transportation company, the administrator picks the driver, then the truck, then the tank. Choosing the driver pre-fills the truck they last operated, which the administrator can accept or change — so the common case is two taps rather than three decisions.

**Why this priority**: This is the decision the driver's verification later checks. Without a truck recorded against the order there is nothing to check against, so US3 is unimplementable — and without a tank, the capacity and grade guards have nothing to validate.

**Independent Test**: Assign one order to a driver, a truck and a tank; confirm the order records all three, that selecting a driver pre-fills their last truck, and that a tank too small for the order or not permitted to carry its grade is never offered. Delivers value on its own: the operator's vehicle choice is finally recorded rather than inferred.

**Acceptance Scenarios**:

1. **Given** an order awaiting assignment, **When** the administrator assigns a driver, a truck and a tank, **Then** the order records all three and the driver is notified.
2. **Given** a driver who has operated a truck before, **When** the administrator selects that driver, **Then** the truck they last operated is pre-filled, and can be accepted or changed.
3. **Given** a driver who has never operated a truck, **When** the administrator selects them, **Then** no truck is pre-filled and one must be chosen explicitly.
4. **Given** a driver whose last truck is withdrawn or already committed elsewhere, **When** the administrator selects that driver, **Then** no suggestion is offered rather than an unusable one.
5. **Given** an order for a quantity or grade a tank cannot take, **When** the administrator views the tank list, **Then** that tank is not offered at all.
6. **Given** a truck or tank already committed to another in-progress order, **When** the administrator attempts to assign it, **Then** the assignment is refused — one truck and one tank per order at a time.
7. **Given** an assignment has been made, **When** the customer views their order, **Then** the vehicle shown to them is the truck actually assigned.
8. **Given** an assignment has been made, **When** the driver opens the delivery, **Then** they can see the assigned tank's code and material.
9. **Given** an order was assigned to a truck whose card is later found unusable, **When** the administrator reassigns the order to a different truck, **Then** the new truck becomes the one the driver's verification must match.

---

### User Story 3 - A driver cannot start until they verify the assigned truck (Priority: P1)

A driver who has been given a delivery sees that they must go to the vehicle and verify it before anything else — by tapping the card fixed to it, or by scanning the code their operator generated for it. Until they do, the delivery cannot begin. Verifying the correct vehicle starts the trip; presenting any other vehicle's credential does not.

**Why this priority**: This is the feature's entire purpose — it is what makes the assignment trustworthy rather than aspirational. It is also the one requirement that changes an existing guarantee (that assignment immediately means "in transit"), so it must land deliberately.

**Independent Test**: Assign a delivery to a driver and truck, confirm the delivery will not start by any other means, present a wrong vehicle's credential and confirm refusal, then verify the right one and confirm the trip begins. Delivers the core assurance on its own.

**Acceptance Scenarios**:

1. **Given** a driver has been assigned a delivery, **When** they open it, **Then** it is presented as not yet started, with verifying the truck as the only way to begin.
2. **Given** a driver at the assigned truck, **When** they tap that truck's card, **Then** the delivery starts and they are shown where to go next.
3. **Given** a driver whose device cannot read NFC, **When** they scan the code generated for that same truck, **Then** the delivery starts exactly as a tap would have started it.
4. **Given** a driver presenting a credential belonging to a different truck — tapped or scanned, **When** they do so, **Then** the delivery does not start, the refusal names the mismatch, and they may try again.
5. **Given** a driver whose delivery has not started, **When** they attempt any later step (loading, arrival, handover), **Then** every one is unavailable.
6. **Given** verification is attempted with no connectivity, **When** the platform cannot be reached, **Then** the delivery does not start, the failure is reported, and nothing is recorded as verified.
7. **Given** repeated failed attempts against the same delivery, **When** a 6th is made within 15 minutes, **Then** further attempts are slowed and the pattern is recorded for the operator.
8. **Given** a delivery verified by scanned code rather than tapped card, **When** the operator reviews it, **Then** they can see which method was used.

---

### User Story 4 - A driver loads at the warehouse and confirms with a second verification (Priority: P2)

Once started, the driver is directed to the fuel warehouse rather than straight to the customer. They fill the tank, then verify the truck a second time to confirm loading is finished. They record no figures — the volume is settled later from the depot's own invoice. Only then does the platform route them to the customer's station.

**Why this priority**: This completes the real-world journey and is what makes the first verification meaningful — but the verification gate (US3) is independently valuable even if the warehouse stage ships after it.

**Independent Test**: Start a verified delivery, confirm the driver is routed to a warehouse and not the customer, confirm loading with no quantity asked for anywhere, and confirm routing switches to the customer's station. Delivers value on its own: the platform finally knows where fuel is sourced and when it was drawn.

**Acceptance Scenarios**:

1. **Given** a delivery that has just been started by a successful verification, **When** the driver views it, **Then** the destination shown is the fuel warehouse, with its location and a navigation action that opens a route to it.
2. **Given** a driver at the warehouse, **When** they verify the truck and confirm loading is complete, **Then** loading is confirmed and the delivery advances toward the customer, with no quantity requested.
3. **Given** loading has not been confirmed, **When** the driver attempts to mark arrival at the customer, **Then** it is unavailable.
4. **Given** a loading confirmation is attempted with a credential that is not the assigned truck's, **When** the driver presents it, **Then** loading is not confirmed and the mismatch is named.
4a. **Given** a driver who has not yet reached the warehouse, **When** they present the correct truck's card, **Then** loading is not confirmed, they are told they are not at the depot and roughly how far away they are, and the refusal is worded distinctly from a wrong-vehicle refusal.
4b. **Given** a driver at the warehouse whose device cannot report its position, **When** they present the correct truck's card, **Then** loading is not confirmed, they are told their location is unavailable rather than that anything is wrong with the truck, and no attempt is recorded against the delivery.
5. **Given** loading has been confirmed, **When** the customer views their order, **Then** they can see the delivery is loaded and on its way, not merely assigned.
6. **Given** a delivery whose loading is confirmed, **When** the driver reviews any screen in the loading flow, **Then** no quantity, volume or numeric entry field appears anywhere.
7. **Given** an order whose fuel grade no warehouse supplies, **When** the operator attempts to assign it, **Then** it does not start and the operator is told why.

---

### User Story 5 - Everyone can see which vehicle is really carrying the order (Priority: P3)

The customer sees the verified vehicle rather than an assumed one, and the operator can review, per delivery, when each verification happened, where the driver was, and which method was used.

**Why this priority**: Valuable for trust and dispute resolution, but the operational flow works without it. It is reporting on top of records the earlier stories already create.

**Independent Test**: Complete a verified delivery and confirm the customer sees the real vehicle and the operator can see both verification events with their times, locations and methods. Delivers value on its own as an audit surface.

**Acceptance Scenarios**:

1. **Given** a delivery whose departure verification succeeded, **When** the customer views it, **Then** the vehicle shown is the one that was physically verified.
2. **Given** a completed delivery, **When** the operator reviews it, **Then** both verifications are listed with when each occurred, where the driver was, and whether a card or a code was used.
3. **Given** a delivery with failed verification attempts, **When** the operator reviews it, **Then** the failed attempts are visible alongside the successful one.
4. **Given** a driver of one transportation company, **When** they attempt to view another company's fleet or verification history, **Then** it is indistinguishable from data that does not exist.

---

### Edge Cases

- **A tank is swapped in the yard without telling the platform.** The driver verifies the tractor, not the trailer, so a substituted tank is not detectable by verification. The tank's code and material are shown to the driver (FR-033a) precisely so a mismatch with the physical trailer is visible to a human, since the platform cannot catch it.
- **A driver's last-used truck now belongs to a different job.** The suggestion is suppressed rather than offered-and-rejected, so the operator is never invited to pick something that will fail.
- **A truck is retired or sold while carrying an order.** Withdrawing a truck must not orphan an in-progress delivery; the delivery it is carrying continues, and the truck becomes unavailable for new assignments only.
- **A card is cloned or a duplicate identifier appears.** Two trucks must never be verifiable by the same card; the platform refuses the second pairing rather than silently allowing an ambiguous match.
- **The driver verifies the right truck but at the wrong moment** — e.g. verifies again after the trip has already started. A repeated verification at a stage that is already complete is refused as out-of-sequence, and does not advance or re-run anything.
- **The order is cancelled between assignment and the departure verification.** The truck is released and a subsequent verification on that delivery is refused.
- **The driver's session is revoked mid-journey** (spec 006 behaviour). The delivery's verified state survives; the driver must sign in again to continue, and no verification is lost or re-required.
- **A delivery completes before its invoice is ever uploaded.** Loading confirmation and delivery do not wait on reconciliation, so a delivery can finish with no volume recorded against it. That state must read as "not yet reconciled", never as a shortfall of the full ordered amount.
- **Two administrators assign the same truck to two orders simultaneously.** Exactly one succeeds; the other is told the truck is no longer free.
- **A transportation company that has not registered any trucks yet.** After cutover this is the normal starting state for every transporter. They must be told their fleet needs registering, rather than being shown an assignment screen that silently offers no vehicles.
- **The generated code is photographed and used away from the vehicle.** The code is inherently copyable in a way a physical card is not, so three controls apply together: it can only be presented through the app's own live camera preview, never from a stored image (FR-036i); the operator can revoke it the moment a leak is suspected (FR-036f); and the platform records which method verified each step, so use of the weaker path is always visible (FR-036c). None of these makes a code as strong as a card — they bound the exposure rather than remove it.
- **A driver has no signal at the depot.** There is no offline capture and no queue — the verification simply does not happen. The driver retries with signal, or their operator overrides the step, which is recorded as an override and never as proof.
- **An operator overrides every delivery as a matter of habit**, defeating the point of verification. The platform cannot prevent this, but every override carries a reason and an author and is visible when reviewing a delivery, so the pattern is detectable rather than invisible.
- **A warehouse is withdrawn while a driver is en route to it.** The delivery already recorded which warehouse it was sent to, so it continues to that one; withdrawal affects only deliveries not yet started.
- **No warehouse supplies the ordered fuel grade anywhere.** The delivery does not start and the operator is told, rather than the driver being routed to a warehouse that cannot fill them.
- **A delivery is cancelled after loading but before handover.** Fuel was drawn from the warehouse but never reached the client. This feature records the cancellation and releases the driver, truck and tank; what it means for volume owed is a reconciliation concern and deliberately not settled here.
- **The same order is loaded twice** (a duplicate loading confirmation). The second is refused as out-of-sequence (FR-025); a delivery passes through the loading stage exactly once.
- **A driver taps the card at the yard fence, or one gate over.** Civilian GPS in a metal depot is not precise, so the radius is deliberately generous (FR-030b) rather than sized to the pump. The geofence is there to catch a driver verifying from a different city, not to adjudicate metres.
- **A driver reports a position their phone did not measure.** A reported fix is a measurement, not a verdict — the platform decides against it, but cannot prove the phone was honest. The geofence raises the cost of verifying from the wrong place; it does not make it impossible, and it is not the last line of defence (the loading confirmation, the customer's own OTP handover, and the recorded distance on every attempt all remain).
- **The driver's location permission is refused at the depot.** Loading cannot be verified at all, and the refusal names the phone rather than the truck (FR-030c). The remedy is granting permission, or the operator's override (FR-047) — which, as always, is recorded as an attestation and never as proof.

## Requirements *(mandatory)*

### Functional Requirements

#### Fleet & card registration (US1)

- **FR-001**: A transportation company administrator MUST be able to register a truck as a record owned by their company, independent of any driver.
- **FR-002**: A truck MUST carry a plate number and whether it is in service. It MUST NOT carry capacity or fuel-grade capability — those belong to the tank (FR-048a).
- **FR-003**: A truck MUST be viewable and modifiable only by its owning transportation company; any other company's attempt MUST be indistinguishable from the truck not existing.
- **FR-004**: An administrator MUST be able to pair exactly one NFC card identifier with a truck, and to replace it later.
- **FR-005**: A card identifier MUST NOT be paired with more than one truck at a time; a conflicting pairing MUST be refused with the conflict named.
- **FR-006**: The pairing surface MUST accept a card identifier entered by a desk-side USB reader without requiring any driver device.
- **FR-007**: An administrator MUST be able to withdraw a truck from service, after which it cannot be newly assigned.
- **FR-008**: Withdrawing a truck MUST NOT interrupt a delivery it is already carrying.

#### Tanks (US1, US2)

- **FR-048**: A **tank** (the trailer or container a truck pulls) MUST be a record owned by the transportation company, distinct from the truck that pulls it.
- **FR-048a**: A tank MUST carry a unique code, a material type (for example iron or aluminium), a maximum capacity, and the set of fuel grades it is permitted to carry.
- **FR-048g**: A tank's material MUST be recorded as fact and MUST NOT by itself determine which grades that tank may carry; permitted grades are stated explicitly per tank.
- **FR-048b**: A tank's code MUST be unique within the platform; a conflicting code MUST be refused with the conflict named.
- **FR-048c**: A tank MUST NOT have an NFC card or generated code of its own. Verification identifies the truck only.
- **FR-048d**: A tank MUST be viewable and modifiable only by its owning transportation company, on the same terms as a truck (FR-003).
- **FR-048e**: An administrator MUST be able to withdraw a tank from service, after which it cannot be newly assigned; withdrawal MUST NOT interrupt a delivery already carrying it.
- **FR-048f**: A tank already committed to an in-progress delivery MUST NOT be assignable to another; exactly one of two simultaneous attempts on the same tank MUST succeed.

#### Assignment (US2)

- **FR-009**: Assigning an order MUST require a driver, a truck, and a tank to be chosen.
- **FR-009a**: The operator MUST choose in the order driver → truck → tank, and the driver list MUST remain ranked by proximity exactly as it is today.
- **FR-009b**: On selecting a driver, the platform MUST pre-fill the truck that driver most recently operated, and the operator MUST be able to accept or change it.
- **FR-009c**: A driver who has operated no truck before MUST produce no pre-filled suggestion, and the operator MUST choose a truck explicitly rather than being shown an arbitrary one.
- **FR-009d**: A pre-filled truck that is withdrawn, or already committed elsewhere, MUST NOT be suggested; the operator MUST be shown that no suggestion is available rather than one they cannot use.
- **FR-009e**: The pre-filled truck MUST be a suggestion only — accepting it MUST be an explicit act, and the platform MUST validate it exactly as it validates a manually chosen one.
- **FR-009f**: The order MUST retain which tank was assigned alongside which truck and driver.
- **FR-010**: A tank MUST be refused for an order whose quantity exceeds that tank's capacity.
- **FR-011**: A tank MUST be refused for an order whose fuel grade it is not permitted to carry.
- **FR-012**: A truck already committed to an in-progress delivery MUST be refused for another; exactly one of two simultaneous attempts on the same truck MUST succeed.
- **FR-013**: The order MUST retain which truck was assigned, and that record MUST be what later verification is checked against.
- **FR-014**: The vehicle shown to the customer MUST be the truck actually assigned to their order.
- **FR-015**: An administrator MUST be able to reassign a delivery to a different truck before it has departed, after which the new truck is the one that must be verified.
- **FR-016**: Trucks and tanks MUST be selectable from the company's own fleet only, and only those currently free and in service MUST be offered.
- **FR-016a**: The tank list offered for an order MUST already exclude tanks too small for it or not permitted to carry its grade, so an operator is never offered a tank the platform will then refuse.

#### Order lifecycle (US3, US4)

- **FR-046**: The order lifecycle MUST gain exactly one new stage, **loading**, sitting between assignment and travelling to the customer. The full sequence is: assigned → *[departure verification]* → loading → *[loading confirmed]* → travelling to the customer → unloading → delivered.
- **FR-046a**: Assignment MUST NOT advance an order past "assigned" on its own. "Assigned" now means the delivery is waiting for the driver to verify the vehicle, and only a successful verification moves it on.
- **FR-046b**: "Travelling to the customer" MUST mean the truck is loaded and on its way — it MUST NOT be used for the leg between departure and the warehouse, which is the loading stage.
- **FR-046c**: Every surface that presents an order's stage — the customer's tracking view, the driver's delivery list and its filters, and any notification naming a stage — MUST account for the loading stage rather than treating it as unrecognised.
- **FR-046d**: An order MUST be cancellable from the loading stage, and doing so MUST release both the driver and the truck.
- **FR-046e**: The administrator's force-complete override MUST remain available from the loading stage, as it already is from the stages either side of it.

#### Departure verification (US3)

> **Verification** below means either accepted method — tapping the truck's NFC card, or scanning the code generated for that same truck (FR-036). Every rule in this section applies identically to both; where a rule is specific to one method it says so.

- **FR-017**: A delivery MUST NOT begin until a successful verification of the assigned truck is recorded.
- **FR-018**: A verification whose credential does not identify the assigned truck MUST refuse to start the delivery and MUST state that the vehicle does not match.
- **FR-019**: A refused verification MUST leave the delivery exactly as it was and MUST allow the driver to try again.
- **FR-020**: Every later step of the delivery MUST be unavailable while the departure verification is outstanding.
- **FR-021**: A verification that cannot reach the platform MUST NOT start the delivery and MUST NOT be recorded; the driver MUST be told it failed.
- **FR-021a**: A verification MUST NOT be captured offline, queued, or held for later submission. If the platform cannot be reached at the moment of the attempt, there is no verification — the driver retries when they have signal, or the operator overrides (FR-047).
- **FR-022**: Whether a verification succeeds MUST be decided by the platform, never by the driver's device alone.
- **FR-023**: Repeated failed verifications MUST be rate-limited at **5 attempts per 15 minutes**, matching the limit the existing proof-of-delivery verify endpoints already enforce, and the pattern MUST be retained for the operator.
- **FR-024**: A successful verification MUST record when it happened, where the driver was at the time, and which method was used.
- **FR-025**: A verification against a stage that is already complete MUST be refused as out-of-sequence without re-running or advancing anything.

#### Warehouse loading (US4)

- **FR-026**: After a successful departure verification, the delivery's next destination MUST be a fuel warehouse, not the customer's station.
- **FR-027**: The driver MUST be shown the warehouse's location and be able to navigate to it.
- **FR-028**: The driver MUST confirm that loading is complete as a plain state transition. The driver's app MUST NOT present any quantity, volume or numeric input at any point in the loading flow.
- **FR-028a**: The platform MUST NOT record a loaded volume captured from the driver. The authoritative volume arrives later, from the Aramco invoice, via the separate reconciliation feature that is out of scope here.
- **FR-029**: Loading confirmation MUST NOT depend on any quantity being known. A delivery MUST be able to complete its loading stage with no volume recorded against it yet.
- **FR-030**: Loading MUST be confirmed by a second successful verification of the assigned truck, subject to the same matching rule as the departure verification (FR-018).
- **FR-030a**: The loading verification MUST additionally require that the driver is at the assigned warehouse. An attempt presenting the correct truck from outside the warehouse's radius MUST be refused, and MUST be refused with a distinct answer from a credential mismatch — the driver is told they are not there yet, and how far short they are, never that they presented the wrong vehicle. The departure verification MUST NOT be geofenced: the truck is wherever the driver's shift starts, and the platform has no opinion about where that is.
- **FR-030b**: The radius MUST be a configurable platform-wide distance, defaulting to **500 m**, and MUST be measured against the warehouse snapshot the delivery was assigned (FR-035e), never against a warehouse record that may have moved since.
- **FR-030c**: The geofence MUST be evaluated against a position fix taken at the moment of the read and sent with it — never against the driver's last streamed position, which is throttled and can be arbitrarily stale. A loading verification arriving with no fix MUST be refused without recording an attempt, and MUST be reported as a device problem distinct from every other refusal. Which stage is being attempted remains the platform's determination (FR-017a): the driver's app MUST NOT decide locally that a fix is unnecessary and withhold it.
- **FR-030d**: The measured distance MUST be recorded on the verification attempt, on refusals as well as successes, so "verified in the yard" and "verified from 4 km away" remain distinguishable afterward.
- **FR-031**: Until loading is confirmed, arrival at the customer MUST be unavailable.
- **FR-032**: Once loading is confirmed, the delivery MUST advance to travelling to the customer's station and the driver MUST be routed there.
- **FR-033**: The platform MUST retain the ordered quantity on every delivery. No actual loaded volume is recorded by this feature.
- **FR-033a**: The driver MUST see the assigned tank's code and material on their active delivery, so they know which trailer they are hauling before they load into it.
- **FR-033b**: The tank's details MUST be visible to the driver from the moment the delivery is assigned, not only after loading.
- **FR-034**: This feature MUST NOT alter any invoice. Reconciling an ordered quantity against a delivered one is explicitly the concern of a separate, later feature and MUST NOT be attempted here.

#### Warehouses (US4)

- **FR-035**: Fuel warehouses MUST be registered by the CIRO platform operator, and MUST belong to neither the fuel company nor the transportation company.
- **FR-035a**: The platform operator MUST be able to load warehouses in bulk, sufficient to cover the country, rather than one at a time only.
- **FR-035b**: A warehouse MUST carry a position on the map, a human-readable address, and the fuel grades it can supply.
- **FR-035c**: Only the platform operator MUST be able to create, alter or withdraw a warehouse; every other role MUST be able to read them but never modify them.
- **FR-035d**: The warehouse selected for a delivery MUST be one that supplies the order's fuel grade, and MUST be the nearest such warehouse to the customer's station.
- **FR-035e**: The warehouse chosen for a delivery MUST be recorded on that delivery and MUST NOT change once loading has begun, so a later change to the warehouse list cannot rewrite where a completed delivery loaded.
- **FR-035f**: When no warehouse supplying the order's fuel grade can be found, the delivery MUST NOT start, and the operator MUST be told why rather than the driver being sent nowhere.

#### Availability & fallback

- **FR-036**: A transportation company administrator MUST be able to generate, for a truck, a QR code that verifies that truck exactly as its NFC card does.
- **FR-036a**: A driver MUST be able to satisfy either verification step by scanning that QR code instead of tapping the card, with the same matching rule (FR-018) and the same outcome.
- **FR-036b**: A QR code MUST verify only the one truck it was generated for; presenting it for any other truck MUST be refused exactly as a mismatched card is.
- **FR-036c**: The platform MUST record which method verified each step — tapped card or scanned code — so the operator can tell them apart.
- **FR-036d**: Generating a QR code MUST NOT invalidate the truck's NFC card; both MUST remain usable.
- **FR-036e**: Replacing a truck's paired card (FR-004) MUST invalidate any QR code previously generated for it, so a superseded credential cannot keep verifying.
- **FR-036f**: A transportation company administrator MUST be able to revoke a truck's generated code at any time, and to issue a replacement.
- **FR-036g**: A revoked code MUST stop verifying immediately, and a later attempt to present it MUST be refused exactly as a mismatched credential is.
- **FR-036h**: A generated code MUST NOT expire on its own. It remains valid until revoked or until the truck's card is replaced, so a driver who depends on it is never stranded mid-shift.
- **FR-036i**: A code MUST be presentable only through the driver app's own live camera preview. The app MUST NOT accept a code from a stored image, a screenshot, a gallery selection, a file, a share or intent from another application, or any scanner outside the app.
- **FR-036j**: The driver app MUST NOT offer any means of importing or uploading an image to satisfy a verification.
- **FR-037**: A driver MUST be told plainly why a delivery cannot start, distinguishing "you have not verified yet" from "that was the wrong vehicle" from "the platform could not be reached".

#### Operator override (US3, US4)

- **FR-047**: A transportation company administrator MUST be able to advance a delivery past a verification step on the driver's behalf, for the case where the driver cannot reach the platform.
- **FR-047a**: An override MUST be available for both verification steps — departure and loading confirmation.
- **FR-047b**: An override MUST require a stated reason, and MUST record which administrator performed it and when.
- **FR-047c**: An override MUST be recorded as an override and MUST NOT be recorded as, or presented as, a verification. The two MUST be distinguishable everywhere either appears.
- **FR-047d**: The customer MUST NOT be told a vehicle was verified when the stage was in fact overridden. Where the customer is shown vehicle information for an overridden delivery, it MUST reflect what was assigned rather than what was proven.
- **FR-047e**: Only an administrator of the transportation company carrying that order MUST be able to override it; any other party's attempt MUST be refused.
- **FR-047f**: Overrides MUST be visible to the operator alongside verifications when reviewing a delivery, so a delivery advanced without proof can always be identified afterwards.
- **FR-047g**: An override MUST NOT bypass the ordering of stages — it advances exactly one outstanding step, and MUST NOT be usable to skip a stage that has not been reached.

#### Visibility & audit (US5)

- **FR-038**: The customer MUST see the verified vehicle for their order once departure has been verified. Where departure was overridden rather than verified, FR-047d governs what the customer is shown.
- **FR-039**: The operator MUST be able to review, per delivery, each verification with its time, the driver's location, and the method used.
- **FR-040**: Failed verification attempts MUST be visible to the operator alongside successful ones.
- **FR-041**: Tap records MUST be readable only within the companies party to that order; any other party's attempt MUST be indistinguishable from data that does not exist.
- **FR-042**: A card identifier MUST NOT be exposed to the customer, and MUST NOT be displayed to a driver — a driver presents the physical credential, never reads its value.

#### Cutover & continuity

- **FR-043**: The per-driver embedded truck MUST be removed outright. No migration MUST promote it into a truck record, and the two arrangements MUST NOT coexist — there is exactly one place a vehicle is defined once this feature lands.
- **FR-043a**: Backward compatibility with trucks or deliveries created before this feature is explicitly NOT required. The cutover is a flag day: existing test data is discarded rather than carried forward.
- **FR-043b**: A delivery carrying no assigned truck MUST be refused at the point of assignment rather than allowed to reach a driver who could never verify it.
- **FR-043c**: After cutover, a transportation company with no registered trucks MUST be unable to accept an order, and MUST be told plainly that its fleet needs registering — never left with an assignment screen that silently offers nothing.
- **FR-044**: A delivery cancelled before departure MUST release its truck for reassignment, and a later verification against that delivery MUST be refused.
- **FR-045**: A driver signing in again after a session ends MUST find the delivery's verified progress intact, with no verification repeated or lost.

### Key Entities

- **Truck**: The tractor — the powered vehicle — owned by a transportation company. Carries a plate number, whether it is in service, and at most one paired card identifier. Holds no capacity or fuel-grade capability of its own. It is the only entity a verification identifies. Exists independently of any driver, and may be assigned to different drivers on different orders.
- **Tank**: The trailer or container a truck pulls, owned by the same transportation company and tracked separately from it. Carries a unique code, a material type (for example iron or aluminium), a maximum capacity, the fuel grades it is permitted to carry, and whether it is in service. This is the record the capacity and grade guards validate. Has no card and no generated code of its own — it is assigned, never verified.
- **Card pairing**: The association between a physical NFC card's identifier and exactly one truck. Replaceable when a card is lost or damaged; never shared between trucks.
- **QR credential**: An operator-generated alternative to a truck's card, verifying the same one truck by the same rule. Superseded when the truck's card is replaced.
- **Warehouse**: A fuel loading point registered by the CIRO platform operator and shared across every tenant — owned by no company. Carries a position on the map, a human-readable address, and the fuel grades it can supply. Read by all roles, written only by the platform operator.
- **Verification record**: A single verification attempt against a delivery — which truck was expected, what was presented, whether it matched, which method was used (card or code), when it happened, where the driver was, and — for a loading attempt — how far that was from the assigned warehouse. Retained for both successful and failed attempts.
- **Order** (existing, extended): Additionally records the assigned truck and tank, the chosen warehouse, the departure verification, and the loading confirmation. It records no actual loaded volume — that arrives, if at all, through the separate reconciliation feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of deliveries that begin have a recorded successful verification of the assigned vehicle — no delivery can start without one.
- **SC-002**: A verification against the wrong vehicle never starts a delivery, in 100% of attempts.
- **SC-003**: An operator can register a truck and pair its card in under 2 minutes, without touching a driver's device.
- **SC-004**: A driver at the correct vehicle can start their delivery within 10 seconds of verifying, on a normal connection. *(Operational target, not a build gate — measured in the field rather than asserted by a test.)*
- **SC-005**: 100% of deliveries that reach the customer have a recorded loading confirmation.
- **SC-005a**: No screen in the driver's app presents a quantity or volume input at any point in the loading flow.
- **SC-006**: The vehicle shown to a customer matches the vehicle physically verified, in 100% of verified deliveries.
- **SC-007**: No truck is ever committed to two in-progress deliveries at the same time, including under simultaneous assignment attempts.
- **SC-008**: No card identifier is ever paired to two trucks at the same time.
- **SC-009**: An operator can determine, for any completed delivery, when and where each verification occurred and by which method, without contacting the driver.
- **SC-010**: A driver shown a refusal can tell which cause applies (not yet verified / wrong vehicle / not at the warehouse / location unavailable / platform unreachable) without contacting support, in 100% of refusals.
- **SC-012**: No loading confirmation is ever recorded against a delivery whose loading verification came from outside the assigned warehouse's radius, in 100% of attempts.
- **SC-011**: Cross-company attempts to read a truck, a tank, a pairing, or a verification history return nothing distinguishable from non-existence, in 100% of attempts.
- **SC-012**: After cutover, no vehicle is defined in two places — the per-driver embedded truck no longer exists anywhere in the platform.
- **SC-014**: No invoice is altered by this feature, in 100% of deliveries.
- **SC-016**: A driver whose device cannot read NFC can still complete a delivery using the generated code, with the same verification guarantee against the wrong vehicle (SC-002).
- **SC-017**: Every warehouse a delivery is sent to supplies that delivery's fuel grade, in 100% of deliveries.
- **SC-018**: No surface anywhere shows a delivery in the loading stage as unrecognised, blank, or mislabelled as travelling to the customer — checked across the customer's tracking view, the driver's list and its filters, and stage notifications.
- **SC-019**: Every delivery advanced by operator override is identifiable as such afterwards, with its reason and the administrator who performed it, in 100% of overridden deliveries.
- **SC-020**: No customer is ever shown a vehicle as verified for a delivery that was advanced by override rather than proven — in 100% of overridden deliveries.
- **SC-021**: No verification is ever accepted that the platform did not itself decide — there is no path by which a device's own judgement advances a delivery.
- **SC-022**: A driver can name the tank they are hauling — its code and material — from their active delivery alone, without contacting their operator.
- **SC-023**: Selecting a driver who has operated a truck before pre-fills that same truck, in 100% of cases where it is still available.
- **SC-024**: No tank is ever committed to two in-progress deliveries at the same time, including under simultaneous assignment attempts.
- **SC-025**: No delivery is ever assigned a tank too small for its quantity or not permitted to carry its grade, in 100% of assignments.
- **SC-026**: An operator is never offered a tank that the platform would then refuse — the offered list and the accepted set agree, in 100% of assignments.
- **SC-027**: A revoked code stops verifying immediately, in 100% of attempts made after revocation.
- **SC-028**: No verification can be satisfied from a stored image — there is no path in the driver app by which a screenshot, gallery item or file advances a delivery.

## Assumptions

- **Trucks are a shared pool, not driver property.** The requested flow ("he chose the driver **and** truck") only makes sense if a truck is not permanently bound to one driver. Trucks are therefore owned by the transportation company and matched to a driver per order. This replaces today's one-truck-per-driver arrangement, in which the vehicle was implied by whoever was assigned.
- **The USB reader behaves as a keyboard.** 13.56 MHz desk readers of this class present themselves as HID keyboard devices and "type" the card identifier into whatever field has focus. The platform therefore needs only a field that accepts the identifier, and requires no driver hardware, no dedicated integration, and no vendor-specific driver.
- **The card identifier is an opaque string.** The platform compares it for equality and does not interpret its structure, so cards of differing encodings work without change.
- **Tapping proves presence, not identity.** A card confirms the driver is at the assigned vehicle. It is not a second authentication factor for the driver, who is already authenticated by their session.
- **A mismatched verification is not driver-overridable.** Letting a driver dismiss a mismatch would defeat the feature. When a card is genuinely unusable, the remedy is the operator reassigning the delivery to another truck (FR-015), not a bypass.
- **One truck carries one order at a time**, mirroring the existing rule that a driver carries one delivery at a time.
- **Existing candidate selection must keep working.** Drivers are currently offered to operators ranked by proximity and filtered by vehicle capability in a single pass; separating trucks from drivers must preserve that outcome for the operator, however it is achieved.
- **Existing proof-of-delivery is unchanged.** The customer handover codes introduced earlier remain exactly as they are; the verifications in this feature are a separate mechanism at a different stage, and neither replaces the other.
- **Location capture reuses existing position reporting.** Drivers already report position during a delivery, so recording where a verification happened introduces no new permission or device capability.
- **The web administration surface does not exist yet.** Fleet registration, card pairing, code generation and warehouse upload are all operator-facing and belong to the planned web dashboard, which has no code today. This blocks launch of the operator half, not its development — trucks, pairings and warehouses can be seeded directly, exactly as station registration was handled previously.
- **The platform does not measure fuel, and this feature does not reconcile it.** Volume is never observed by the driver, the app, or the delivery flow. The authoritative figure is the official Aramco invoice issued to the gas station company, which enters the platform later through a separate feature. Keeping an unverifiable hand-typed number out of the system entirely is the point; the cost is that a delivery completes without its volume being known, which is accepted.
- **Warehouses are reference data, not tenant data.** Because the platform operator registers them for the whole country and every company loads from the same physical depots, warehouses are readable by all roles and writable by none but the operator. They are the first entity in the platform with that shape.
- **The tank is assigned but not verified.** The card is on the tractor, so verification proves the driver is at the right truck and says nothing about which trailer is coupled to it. This is a deliberate boundary: showing the driver the tank's code and material (FR-033a) makes a wrong trailer visible to a person, but the platform does not attempt to prove it.
- **Proximity is a property of drivers, not vehicles.** Drivers report position and trucks do not, so ranking by distance continues to rank drivers. Trucks and tanks are yard assets filtered by availability, never by location.
- **Capability filtering leaves the driver query entirely.** Because capacity and grade now live on the tank, and the operator picks driver → truck → tank in sequence, the driver list no longer needs to filter on vehicle capability at all — it ranks by proximity and availability only. The single-pass query that previously had to combine distance with vehicle capability is therefore no longer required, and the constraint that forced vehicles to be denormalised onto the driver record disappears with it.
- **An override is an attestation, not proof.** The operator is not at the vehicle, so an override can never carry the same weight as a verification. It exists so a signal dead zone does not halt a delivery, and it is labelled distinctly precisely because it proves less — the platform's job is to record the difference honestly, not to hide it.
- **The generated code is a fallback, not a peer.** Tapping a physical card is the intended path because presence at the vehicle is what it proves. The code exists so a device without NFC does not stop a driver working, and the platform records which was used precisely because they are not equally strong. Restricting it to a live camera preview raises the cost of misuse — a stored screenshot no longer works — without pretending the gap is closed: a camera can still be pointed at a printed copy.

## Dependencies

- **Depends on the planned web administration dashboard** for fleet registration, card pairing, code generation and the platform operator's warehouse upload to be usable in production. Development can proceed without it; launch of the operator-facing half cannot.
- **Changes an existing guarantee**: assignment currently means a delivery is immediately in transit. This feature inserts verification and loading between those two points, so anything that assumed "assigned implies moving" must be revisited.
- **Replaces the current vehicle arrangement as a clean cut**: the per-driver embedded truck is deleted, not migrated, and each transportation company registers its fleet fresh. This is a flag day, accepted because the platform is pre-production and holds only test data. The operator's candidate selection is simplified rather than complicated by the separation: capability moves to the tank, so driver ranking reduces to proximity and availability.
- **Leaves volume unreconciled by design.** A delivery completes with no actual volume recorded. The follow-on feature covering Aramco invoice upload, reconciliation and the client litre balance is what closes that loop; until it exists, ordered quantity is the only figure the platform holds.
- **Requires a national warehouse dataset.** The platform operator must have the list of Saudi warehouses to load, with positions and the grades each supplies. Without it, no delivery can be routed to load, so this is a launch prerequisite for the whole feature and not only its operator-facing half.
- **Barely touches the CLIENT persona.** With the litre balance deferred, the only customer-visible change is which vehicle is shown for their order (FR-014, FR-038, FR-047d). This feature is otherwise entirely operator- and driver-facing.
- **Adds a device capability**: reading NFC on the driver's phone. The generated code (FR-036) is the fallback for devices without it, but the primary path needs hardware the app has never used.
