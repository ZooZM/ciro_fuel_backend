<!--
SYNC IMPACT REPORT
==================
Version change: 0.0.0 (unratified template) → 1.0.0 (initial ratification)
Bump rationale: MAJOR — first concrete adoption; all placeholder principles
                replaced with binding, project-specific governance.

Modified principles (placeholder → concrete):
  [PRINCIPLE_1] → I. Strict Typing & No Magic Values
  [PRINCIPLE_2] → II. Tenant Isolation & Security-First
  [PRINCIPLE_3] → III. Centralized Error Handling
  [PRINCIPLE_4] → IV. Clean Architecture & UI/Logic Decoupling
  [PRINCIPLE_5] → V. Transactional Integrity for State Changes

Added sections:
  - Platform-Specific Binding Constraints (Backend / Mobile / Web)
  - Development Workflow & Quality Gates
  - Governance (amendment + versioning + compliance policy)

Removed sections: none (all template slots filled)

Templates requiring updates:
  ✅ .specify/templates/plan-template.md  — generic "Constitution Check" gate
     dynamically references this file; no hardcoded principles to edit.
  ✅ .specify/templates/spec-template.md  — no constitution-coupled sections; aligned.
  ✅ .specify/templates/tasks-template.md — task categories compatible with new
     principle-driven types (error handling, transactions, tests); no edit needed.
  ✅ .specify/templates/checklist-template.md — generic; aligned.
  ✅ CLAUDE.md — binding constraints (server.ts, sys_storge, tenant plugin,
     transactions) already consistent with Principles II/V and Backend constraints.

Follow-up TODOs: none. RATIFICATION_DATE set to first adoption (2026-07-20).
-->

# B2B Fuel Delivery SaaS Constitution

This Constitution is the absolute, overriding authority for the entire platform across
all tech stacks — Backend (NestJS), Mobile (Flutter), and Web Dashboard (React). Its rules
are non-negotiable and MUST be honored in every architectural decision and every piece of
code produced for the project. Where any other document, habit, or convenience conflicts
with this Constitution, this Constitution wins.

## Core Principles

### I. Strict Typing & No Magic Values

Strict static typing is mandatory across every codebase: TypeScript (with `strict` mode)
for Backend and Web, and strongly typed Dart for Mobile. Implicit `any`, untyped payloads,
and unchecked casts are prohibited at module boundaries.

Magic strings and magic numbers are forbidden. Every literal that carries meaning — roles,
statuses, limits, keys, routes, error codes — MUST be expressed as an Enum, a named constant,
or a configuration value, and referenced by name.

**Rationale**: A multi-tenant financial-adjacent platform cannot tolerate silent type
coercion or scattered literals; typed contracts and named values make lifecycle, role, and
tenant rules verifiable at compile time rather than discoverable in production.

### II. Tenant Isolation & Security-First

Tenant data isolation is paramount and MUST NEVER be left to per-feature developer
discipline. Every tenant-scoped read and write MUST automatically carry the acting user's
`companyId`, enforced by a global mechanism (interceptor + Mongoose plugin fed by
request-scoped context), not by hand-written filters. Cross-tenant access attempts MUST be
denied without revealing whether the target record exists.

Security decisions default to the safe option: authenticate before any data access, enforce
role-based access control server-side as the source of truth, and never expose secrets,
raw payment card data, or one-time proof-of-delivery codes through any response.

**Rationale**: This is a B2B SaaS where competing companies share infrastructure; a single
cross-boundary leak is a business-ending event, so isolation must be structural and automatic.

### III. Centralized Error Handling

Every application MUST route errors through a single, centralized handling layer — Global
Exception Filters in NestJS, and centralized error interceptors/boundaries in Flutter and
React. Ad-hoc `try/catch` that swallows errors or returns inconsistent shapes is prohibited.

Error responses MUST use a uniform, typed shape and MUST NOT leak internal details or tenant
existence across boundaries.

**Rationale**: Consistent, centralized error handling is what makes failures observable,
auditable, and safe — and is the enforcement point for the 404-not-403 isolation rule.

### IV. Clean Architecture & UI/Logic Decoupling

Business logic MUST be decoupled from presentation everywhere. Mobile (Flutter) MUST follow
Clean Architecture with distinct Presentation, Domain, and Data layers; the Domain layer MUST
remain independent of frameworks and external packages via abstract interfaces and dependency
injection. All API communication MUST flow through dedicated repository classes with structured
error parsing. Web (React) MUST use strictly typed functional components and hooks — no class
components — with state management and data fetching separated from UI via custom hooks.
Backend MUST preserve module/service/controller/DTO/guard/interceptor separation.

Widgets and components render and capture interaction; they do not own business rules.

**Rationale**: Decoupled layers keep the enforced lifecycle, dispatch, and pricing rules
testable in isolation and portable across the three clients that consume the same domain.

### V. Transactional Integrity for State Changes

State-changing operations bound by business-logic constraints MUST execute inside ACID
transactions (MongoDB `ClientSession`). This is strictly required for driver dispatch/assignment
and payment-webhook processing, and applies to any operation where a partial write could
double-book a resource, double-charge, or corrupt the order lifecycle.

Concurrency safety MUST be guaranteed at the data layer (conditional updates + unique indexes),
not assumed from application ordering.

**Rationale**: Dispatch and payment are inherently race-prone; transactional, DB-enforced
guarantees are the only defense against double-booking and duplicate financial effects.

## Platform-Specific Binding Constraints

These constraints are enforced in addition to the Core Principles and are non-negotiable.

**Backend (NestJS / Node.js)**
- The root entry file MUST be named exactly `server.ts` (compiling to `server.js`). Generating
  or suggesting `index.ts` / `index.js` at the repository root is prohibited.
- All local file uploads MUST be written under a directory named exactly `sys_storge`.
- Every tenant-scoped query MUST automatically inject `companyId` via the global
  interceptor/plugin mechanism (Principle II).
- ACID transactions (`ClientSession`) are mandatory for driver dispatch and payment-webhook
  confirmation (Principle V).

**Mobile (Flutter)**
- Clean Architecture layering (Presentation / Domain / Data) is mandatory; the Domain layer
  stays framework-independent behind abstract interfaces and DI.
- UI is fully decoupled from business logic; all network access goes through repository classes
  with structured error parsing.

**Web Dashboard (React)**
- Strictly typed functional components and hooks only; class components are prohibited.
- State management and API fetching are separated from UI via custom hooks.
- RBAC MUST be enforced client-side by conditionally rendering navigation and actions based on
  the user's role and tenant context — as a UX layer over, never a replacement for, server-side
  authorization.

## Development Workflow & Quality Gates

- Every feature passes the plan-time **Constitution Check** gate before implementation; any
  deviation MUST be recorded in the plan's Complexity Tracking with justification, or the design
  MUST be revised to comply.
- Code review MUST verify adherence to all five Core Principles and the Platform-Specific
  Constraints; a change that violates a principle without an approved, documented exception
  cannot merge.
- Guarantees the spec marks as testable (tenant isolation, lifecycle validity, no double-booking,
  payment idempotency, proof-of-delivery, presence) MUST have automated tests before the
  corresponding capability is considered done.
- CI MUST enforce mechanical constraints, including failing the build on any root-level
  `index.ts` / `index.js`.

## Governance

This Constitution supersedes all other practices, conventions, and preferences. When guidance
conflicts, the Constitution controls.

**Amendments**: Changes MUST be proposed as an explicit edit to this file, accompanied by a Sync
Impact Report and propagation to dependent templates and guidance docs. Amendments take effect
only once merged.

**Versioning**: This document follows semantic versioning:
- **MAJOR** — backward-incompatible governance changes or principle removals/redefinitions.
- **MINOR** — a new principle/section is added or existing guidance is materially expanded.
- **PATCH** — clarifications, wording, and non-semantic refinements.

**Compliance review**: All PRs and reviews MUST verify compliance with this Constitution.
Complexity that departs from these principles MUST be justified in-plan or removed. Runtime,
project-specific development guidance is maintained in `CLAUDE.md` and the active feature's
plan under `specs/`.

**Version**: 1.0.0 | **Ratified**: 2026-07-20 | **Last Amended**: 2026-07-20
