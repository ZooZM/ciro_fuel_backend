<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
`specs/001-fuel-delivery-platform/plan.md`

Supporting design artifacts for the active feature:
- Spec: `specs/001-fuel-delivery-platform/spec.md`
- Research decisions: `specs/001-fuel-delivery-platform/research.md`
- Data model: `specs/001-fuel-delivery-platform/data-model.md`
- Contracts: `specs/001-fuel-delivery-platform/contracts/` (rest-api, websocket-events, payment-webhook)
- Quickstart: `specs/001-fuel-delivery-platform/quickstart.md`

Binding constraints: entry file is `src/server.ts` (never index.ts/index.js at root);
upload directory is exactly `sys_storge`; MongoDB transactions required for driver
assignment and payment webhook; tenant isolation via global Mongoose plugin + AsyncLocalStorage;
payment timeouts via BullMQ delayed jobs (Redis), NOT interval sweeps; truck capabilities
denormalized on the driver document (no $lookup with $near); drivers auto-marked offline
after 6 silent minutes; COMPANY_ADMIN force-complete override is audited in statusHistory.
<!-- SPECKIT END -->
