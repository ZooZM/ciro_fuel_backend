# Payment Webhook Contract — Sadad / Mada

**Endpoint**: `POST /api/v1/payments/webhook/:gateway` where `:gateway ∈ { sadad, mada }` — **[public]** (no JWT), authenticated by HMAC signature.

## Security

- Header `X-Signature`: hex HMAC-SHA256 of the raw request body using the per-gateway shared secret (`PAYMENT_SADAD_SECRET` / `PAYMENT_MADA_SECRET` env vars).
- Raw-body capture enabled for this route only (Nest `rawBody: true`) — signature computed over bytes, not re-serialized JSON.
- Invalid signature ⇒ `401`, event recorded with `outcome: INVALID_SIGNATURE`, no state change.
- Route excluded from tenant context (no JWT); tenant resolved from the order.

## Request body (normalized shape both gateways map into)

```jsonc
{
  "transactionId": "SDD-2026-000123",   // gateway's unique id — idempotency key
  "orderId": "6633aa00b1c2…",           // platform order id (merchant reference)
  "amount": 15750.00,
  "currency": "SAR",
  "status": "PAID",                     // only PAID triggers transition; others logged
  "paidAt": "2026-07-19T10:12:33Z"
}
```

## Processing (all within the contract of R5 / FR-014 / FR-015 / FR-015a)

1. Verify signature → else `401`.
2. Insert `payment_events` doc with unique `gatewayTransactionId`.
   - Duplicate key ⇒ **`200 { received: true, duplicate: true }`** — no state change (FR-015; 200 stops gateway retries).
3. Validate `amount === order.finalPrice` and `currency === "SAR"` ⇒ else record `AMOUNT_MISMATCH`, return `200 { received: true, accepted: false }`, notify COMPANY_ADMIN for reconciliation.
4. In a Mongoose `ClientSession` transaction:
   - Conditional transition `PENDING_PAYMENT → IN_TRANSIT` (state service).
   - Link `paymentConfirmationId` on the order; mark event `CONFIRMED`.
   - After commit: remove the BullMQ `payment-timeout` job (`jobId = orderId`); a processor racing this removal is safe — its conditional transition finds the order no longer in `PENDING_PAYMENT` and no-ops (R6).
5. Order not in `PENDING_PAYMENT` (expired deadline, cancelled, replayed after success) ⇒ event recorded `OUT_OF_SEQUENCE`, **`200 { received: true, accepted: false }`**, flagged for manual reconciliation (spec edge case).
6. On success emit `order:status` socket event + `notification:new` to client and admin.

## Response codes

| Code | Meaning |
|------|---------|
| 200 | Acknowledged (accepted, duplicate, or recorded-but-not-applied — body distinguishes) |
| 400 | Malformed payload (missing required fields) |
| 401 | Bad/missing signature |

Never return 5xx for business-state mismatches — gateways retry on 5xx, which would amplify replays.
