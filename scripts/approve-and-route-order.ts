/**
 * Feature 009 T062 / quickstart.md Part 3 step 2 — "the fuel company approves
 * and routes, by script; no screen exists for this persona" (FR-035, FR-036).
 *
 * Signs in as the Fuel Company admin and calls the real
 * `PATCH /orders/:id/approve` (and, only when the response is ambiguous
 * because more than one Transportation Company serves the region,
 * `PATCH /orders/:id/route`) — the exact endpoints and authorization a real
 * admin would use. No stored data is written directly and there is no
 * auto-advance flag: the platform's genuine pricing and routing logic runs.
 *
 * Credentials default to whatever `npm run seed:dashboard` last wrote into
 * `postman/ciro-fuel-local.postman_environment.json` (`companyAdminEmail`/
 * `companyAdminPassword`) so the two scripts stay pointed at the same run
 * without retyping anything; override with FUEL_ADMIN_EMAIL/
 * FUEL_ADMIN_PASSWORD if approving against a different seed.
 *
 *   npm run approve-route -- <orderId>
 *   TRANSPORT_COMPANY_ID=<id> npm run approve-route -- <orderId>   # when several transporters serve the region
 *   npm run approve-route -- ALL   # every PENDING_APPROVAL order for this admin's company —
 *                                  # the practical way to route a whole seeded batch (see
 *                                  # DRIVER_COUNT/ORDER_COUNT in seed-dashboard-actors.ts)
 *                                  # for assignment testing, without calling this once per id.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000/api/v1';

async function call<T>(
  path: string,
  init: { method: string; token?: string; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(BASE_URL + path, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${init.method} ${path} → ${res.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

/** Reads the Fuel Company admin credentials `seed:dashboard` last wrote, so
 *  this script always targets the same run without the operator retyping a
 *  freshly-minted email. */
function credentialsFromPostmanEnvironment(): { email: string; password: string } {
  const path = join(__dirname, '..', 'postman', 'ciro-fuel-local.postman_environment.json');
  const env = JSON.parse(readFileSync(path, 'utf8')) as { values: { key: string; value: string }[] };
  const find = (key: string) => env.values.find((v) => v.key === key)?.value;
  const email = find('companyAdminEmail');
  const password = find('companyAdminPassword');
  if (!email || !password) {
    throw new Error(`companyAdminEmail/companyAdminPassword missing from ${path} — run npm run seed:dashboard first`);
  }
  return { email, password };
}

/** Approves one order and, only when genuinely ambiguous, follows up with the manual
 *  route call — the same logic whether driven for one id or a whole batch. */
async function approveAndRoute(orderId: string, accessToken: string): Promise<void> {
  let order = await call<{
    status: string;
    routingCandidates?: { id: string; name: string }[];
  }>(`/orders/${orderId}/approve`, { method: 'PATCH', token: accessToken, body: {} });
  console.log(`  ✔ approved ${orderId} — status is now ${order.status}`);

  if (order.status === 'PENDING_PAYMENT') {
    console.log('    (DIRECT-paid — routing resumes only once the payment webhook settles it)');
    return;
  }

  if (order.status === 'AWAITING_ROUTING') {
    if (order.routingCandidates && order.routingCandidates.length > 0) {
      const transportCompanyId = process.env.TRANSPORT_COMPANY_ID ?? order.routingCandidates[0].id;
      console.log(
        `    several transporters serve this region — routing to ${transportCompanyId}` +
          (process.env.TRANSPORT_COMPANY_ID ? '' : ` (${order.routingCandidates[0].name}, first candidate)`),
      );
      order = await call(`/orders/${orderId}/route`, {
        method: 'PATCH',
        token: accessToken,
        body: { transportCompanyId },
      });
      console.log(`  ✔ routed ${orderId} — status is now ${order.status}`);
    } else {
      console.log('    no transporter serves this region (seed 13 missing) — stays AWAITING_ROUTING');
    }
    return;
  }

  console.log(`  ✔ routed automatically ${orderId} — status is now ${order.status}`);
}

/** Cursor-pages every PENDING_APPROVAL order visible to this admin (multi-party scoping
 *  keeps it to their own company) — `GET /orders` never returns a total, only a cursor. */
async function listAllPendingApproval(accessToken: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ status: 'PENDING_APPROVAL', ...(cursor ? { cursor } : {}) });
    const page = await call<{ items: { _id: string }[]; nextCursor: string | null }>(
      `/orders?${query.toString()}`,
      { method: 'GET', token: accessToken },
    );
    ids.push(...page.items.map((o) => o._id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return ids;
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    throw new Error('Usage: npm run approve-route -- <orderId>|ALL');
  }

  const { email, password } =
    process.env.FUEL_ADMIN_EMAIL && process.env.FUEL_ADMIN_PASSWORD
      ? { email: process.env.FUEL_ADMIN_EMAIL, password: process.env.FUEL_ADMIN_PASSWORD }
      : credentialsFromPostmanEnvironment();

  const { accessToken } = await call<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: { email, password },
  });

  if (target.toUpperCase() !== 'ALL') {
    console.log(`Approving order ${target} as ${email}\n`);
    await approveAndRoute(target, accessToken);
    return;
  }

  console.log(`Listing PENDING_APPROVAL orders for ${email}...`);
  const orderIds = await listAllPendingApproval(accessToken);
  console.log(`Found ${orderIds.length} order(s) to approve+route\n`);

  let failed = 0;
  for (const orderId of orderIds) {
    try {
      await approveAndRoute(orderId, accessToken);
    } catch (err) {
      failed += 1;
      console.error(`  ✘ ${orderId} failed: ${(err as Error).message}`);
    }
  }
  console.log(`\nDone — ${orderIds.length - failed}/${orderIds.length} succeeded.`);
}

main().catch((err: Error) => {
  console.error(`\nApprove/route failed: ${err.message}`);
  process.exit(1);
});
