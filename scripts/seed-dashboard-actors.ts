/**
 * Seeds one complete, self-consistent set of actors for the order-cycle test
 * dashboard (`public/`) — a Fuel Company, a Transportation Company serving the
 * client's region, a client with a station and a driver with a truck, all with
 * known passwords.
 *
 * It drives the public REST API rather than writing to Mongo directly, on
 * purpose: every actor here is created by the exact role the platform requires
 * (CIRO registers the Fuel Company, the Fuel Company admin onboards the
 * transporter and the client, the transporter admin creates its own driver), so
 * a successful run is itself proof that the onboarding chain works.
 *
 * Idempotency comes from a per-run suffix — every run creates a fresh, isolated
 * set rather than mutating an existing one, which keeps repeated runs safe.
 *
 *   npm run seed:dashboard
 *   BASE_URL=http://localhost:3000/api/v1 npm run seed:dashboard
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { io } from 'socket.io-client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000/api/v1';
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL ?? 'owner@example.com';
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD ?? 'change-me-please-16chars';

// One password for every seeded actor — this is throwaway test data whose whole
// purpose is being easy to type into five login boxes.
const PASSWORD = process.env.SEED_PASSWORD ?? 'Password123!';

// The client's station must sit in a region the transporter serves, or approval
// parks the order in AWAITING_ROUTING with no candidates (FR-016) and the
// dashboard's happy path cannot complete.
const REGION_CODE = 'RIYADH';
const GOVERNORATE_CODE = 'RIYADH_CITY';
const STATION_LOCATION = { longitude: 46.6753, latitude: 24.7136 };
const SOCKET_URL = BASE_URL.replace(/\/api\/v1$/, '');

// How much fleet/order volume to seed — override for a bigger stress-test fixture,
// e.g. `DRIVER_COUNT=15 ORDER_COUNT=50 npm run seed:dashboard`.
const DRIVER_COUNT = Number(process.env.DRIVER_COUNT ?? 6);
const ORDER_COUNT = Number(process.env.ORDER_COUNT ?? 25);

const suffix = Date.now().toString().slice(-8);
const tag = (name: string) => `${name}${suffix}`;

interface Actor {
  role: string;
  login: string;
  password: string;
  note: string;
}

async function call<T>(
  path: string,
  init: { method: string; token?: string; body?: unknown; form?: FormData },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  // `/auth/login` is rate-limited to 10/min per IP (auth.controller.ts) — shared across
  // EVERY login this script makes (super admin, fuel admin, transport admin, client, and
  // one per seeded driver). `DRIVER_COUNT` beyond a handful pushes total logins past that
  // limit well within a minute; retrying on 429 with the server's own `Retry-After` is what
  // makes any `DRIVER_COUNT` reliable instead of picking an arbitrary "safe" ceiling.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE_URL + path, {
      method: init.method,
      headers,
      body: init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    });

    if (res.status === 429 && attempt < 5) {
      const retryAfterSeconds = Number(res.headers.get('retry-after')) || 15;
      console.log(`  … rate limited on ${path}, waiting ${retryAfterSeconds}s (attempt ${attempt + 1}/5)`);
      await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
      continue;
    }

    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new Error(`${init.method} ${path} → ${res.status}: ${JSON.stringify(parsed)}`);
    }
    return parsed as T;
  }
}

const login = (credential: Record<string, string>) =>
  call<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: { ...credential, password: credential.password ?? PASSWORD },
  });

/**
 * Brings a driver genuinely online with a real position — `isOnline` and
 * `location` are runtime presence state (`presence.service.ts`,
 * `tracking.gateway.ts`), never fields `CreateUserDto` accepts. Connects to
 * `/tracking` exactly as the mobile app does, sends one `location:update`
 * (always accepted for a driver's first-ever point — no prior location to
 * conflict with), then disconnects; presence itself outlives the socket
 * (`lastSeenAt`), so the driver stays a genuine `$geoNear` candidate.
 */
function connectDriverOnline(token: string, point: { lat: number; lng: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = io(`${SOCKET_URL}/tracking`, { auth: { token }, transports: ['websocket'] });
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('driver socket connection timed out'));
    }, 10_000);
    socket.on('connect', () => {
      socket.emit(
        'location:update',
        { lat: point.lat, lng: point.lng, recordedAt: new Date().toISOString() },
        () => {
          clearTimeout(timeout);
          socket.disconnect();
          resolve();
        },
      );
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Reads a key out of `.env` without pulling in a loader — the gateway secrets
 *  must match the running server exactly or every webhook 401s. */
function envFileValue(key: string): string {
  try {
    const line = readFileSync(join(__dirname, '..', '.env'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : '';
  } catch {
    return '';
  }
}

/**
 * Rewrites the Postman environment to match what was just seeded. Every run
 * mints new emails, so a hand-maintained environment goes stale the moment
 * anyone re-seeds — regenerating it here is what keeps Postman and the
 * dashboard testing the *same* accounts. Variable names mirror the collection's
 * (`companyAdminEmail` is the Fuel Company admin, predating spec 004's rename).
 */
function writePostmanEnvironment(actors: {
  fuelAdminEmail: string;
  transportAdminEmail: string;
  clientPhone: string;
  driverPhone: string;
  fuelAdminBEmail: string;
  referenceOrderId: string;
}): void {
  const secret = (value: string) => ({ value, type: 'secret', enabled: true });
  const plain = (value: string) => ({ value, type: 'default', enabled: true });

  const values = Object.entries({
    baseUrl: plain(BASE_URL),
    superAdminEmail: plain(SUPER_ADMIN_EMAIL),
    superAdminPassword: secret(SUPER_ADMIN_PASSWORD),
    companyAdminEmail: plain(actors.fuelAdminEmail),
    companyAdminPassword: secret(PASSWORD),
    transportAdminEmail: plain(actors.transportAdminEmail),
    transportAdminPassword: secret(PASSWORD),
    clientPhone: plain(actors.clientPhone),
    clientPassword: secret(PASSWORD),
    driverPhone: plain(actors.driverPhone),
    driverPassword: secret(PASSWORD),
    fuelAdminBEmail: plain(actors.fuelAdminBEmail),
    fuelAdminBPassword: secret(PASSWORD),
    referenceOrderId: plain(actors.referenceOrderId),
    paymentSadadSecret: secret(envFileValue('PAYMENT_SADAD_SECRET')),
    paymentMadaSecret: secret(envFileValue('PAYMENT_MADA_SECRET')),
  }).map(([key, rest]) => ({ key, ...rest }));

  const target = join(__dirname, '..', 'postman', 'ciro-fuel-local.postman_environment.json');
  writeFileSync(
    target,
    `${JSON.stringify(
      {
        // Stable id/name so re-importing replaces the environment in place
        // rather than piling up copies.
        id: 'c1r0-fu3l-4p1-3nv-l0c41-0001',
        name: 'Ciro Fuel – Local',
        values,
        _postman_variable_scope: 'environment',
      },
      null,
      2,
    )}\n`,
  );
  console.log('✔ postman/ciro-fuel-local.postman_environment.json regenerated\n');
}

async function main(): Promise<void> {
  const actors: Actor[] = [];
  console.log(`Seeding dashboard actors against ${BASE_URL} (suffix ${suffix})\n`);

  // 1. CIRO — the only role that may register a Fuel Company.
  const superAdmin = await login({ email: SUPER_ADMIN_EMAIL, password: SUPER_ADMIN_PASSWORD });
  console.log('✔ logged in as SUPER_ADMIN');
  actors.push({
    role: 'SUPER_ADMIN',
    login: SUPER_ADMIN_EMAIL,
    password: SUPER_ADMIN_PASSWORD,
    note: 'platform operator (pre-existing seed)',
  });

  // 2. Fuel Company + its admin. Registration is multipart — the commercial
  //    register file is mandatory (FR-018), so the fixture PDF stands in.
  const registerPdf = readFileSync(join(__dirname, 'fixtures', 'sample-register.pdf'));
  const form = new FormData();
  form.append('name', `Dashboard Fuel Co ${suffix}`);
  form.append('contactEmail', `contact@${tag('fuel')}.test`);
  form.append('contactPhone', `+9665${suffix}`);
  form.append('adminEmail', `fuel@${tag('dash')}.test`);
  form.append('adminFullName', 'Dashboard Fuel Admin');
  form.append('adminPhone', `+9665100${suffix.slice(-5)}`);
  form.append('adminPassword', PASSWORD);
  form.append(
    'commercialRegister',
    new Blob([new Uint8Array(registerPdf)], { type: 'application/pdf' }),
    'register.pdf',
  );

  const fuel = await call<{ company: { _id: string }; admin: { email: string } }>('/companies', {
    method: 'POST',
    token: superAdmin.accessToken,
    form,
  });
  const fuelCompanyId = fuel.company._id;
  console.log(`✔ fuel company ${fuelCompanyId}`);
  actors.push({
    role: 'FUEL_COMPANY_ADMIN',
    login: fuel.admin.email,
    password: PASSWORD,
    note: 'approves, prices, routes, force-completes',
  });

  const fuelAdmin = await login({ email: fuel.admin.email });

  // 3. Prices — without them an order has no estimatedPrice to approve against.
  await call(`/companies/${fuelCompanyId}/fuel-prices`, {
    method: 'PUT',
    token: fuelAdmin.accessToken,
    body: {
      prices: [
        { fuelType: 'DIESEL', basePricePerLiter: 2.1 },
        { fuelType: 'PETROL_91', basePricePerLiter: 2.33 },
        { fuelType: 'PETROL_95', basePricePerLiter: 2.55 },
        { fuelType: 'KEROSENE', basePricePerLiter: 1.95 },
      ],
    },
  });
  console.log('✔ fuel prices set');

  // 4. Transportation Company under that Fuel Company, then its region
  //    coverage — exactly one transporter serving the region means approval
  //    routes automatically instead of stalling on a choice (FR-014).
  const transport = await call<{ company: { _id: string }; admin: { email: string } }>(
    `/companies/${fuelCompanyId}/transporters`,
    {
      method: 'POST',
      token: fuelAdmin.accessToken,
      body: {
        name: `Dashboard Transport Co ${suffix}`,
        contactEmail: `contact@${tag('transport')}.test`,
        contactPhone: `+9665200${suffix.slice(-5)}`,
        adminEmail: `transport@${tag('dash')}.test`,
        adminFullName: 'Dashboard Transport Admin',
        adminPhone: `+9665300${suffix.slice(-5)}`,
        adminPassword: PASSWORD,
      },
    },
  );
  const transportCompanyId = transport.company._id;
  console.log(`✔ transport company ${transportCompanyId}`);
  actors.push({
    role: 'TRANSPORT_COMPANY_ADMIN',
    login: transport.admin.email,
    password: PASSWORD,
    note: 'assigns drivers, settles DEFERRED invoices',
  });

  await call(`/companies/${transportCompanyId}/regions`, {
    method: 'PUT',
    token: fuelAdmin.accessToken,
    body: { regionCodes: [REGION_CODE] },
  });
  console.log(`✔ transporter serves ${REGION_CODE}`);

  // 5. Client — created by the Fuel Company, stationed in the served region.
  const clientPhone = `+9665400${suffix.slice(-5)}`;
  const client = await call<{ _id: string }>('/users', {
    method: 'POST',
    token: fuelAdmin.accessToken,
    body: {
      role: 'CLIENT',
      email: `client@${tag('dash')}.test`,
      password: PASSWORD,
      fullName: 'Dashboard Client',
      phone: clientPhone,
      station: {
        regionCode: REGION_CODE,
        governorateCode: GOVERNORATE_CODE,
        location: STATION_LOCATION,
        addressText: 'Dashboard test station, Riyadh',
        name: 'Dashboard Station',
      },
    },
  });
  console.log('✔ client created');
  actors.push({
    role: 'CLIENT',
    login: clientPhone,
    password: PASSWORD,
    note: 'creates orders, reads OTPs — logs in by PHONE',
  });

  // 5a. spec 005 T129: itemised pricing (FR-011) — without this, /orders/quote
  // 409s with PRICING_NOT_CONFIGURED and the seeded orders below never happen.
  await call(`/companies/${fuelCompanyId}/pricing-config`, {
    method: 'PUT',
    token: fuelAdmin.accessToken,
    body: {
      deliveryFee: 30,
      serviceFeePercent: 1,
      taxRatePercent: 15,
      tankerCapacitiesLiters: [20000, 22000, 32000, 33000, 36000, 42000, 46000],
    },
  });
  console.log('✔ pricing config set');

  // 5b. spec 005 T129/D2: two more stations, so the app's multi-station UI
  // (favourite, switch) has more than one real row to show — the default
  // station above already exists from step 5, these are additional.
  for (const [name, addressText] of [
    ['Dashboard Station — North', 'Al Olaya, Riyadh'],
    ['Dashboard Station — East', 'Al Naseem, Riyadh'],
  ] as const) {
    await call(`/users/${client._id}/stations`, {
      method: 'POST',
      token: fuelAdmin.accessToken,
      body: {
        name,
        regionCode: REGION_CODE,
        governorateCode: GOVERNORATE_CODE,
        location: STATION_LOCATION,
        addressText,
      },
    });
  }
  console.log('✔ two additional client stations registered');

  // 5b. Feature 009 quickstart.md Part 2 record 8: a warehouse supplying this
  // order's fuel grades — SUPER_ADMIN-only (FR-035c). Without one,
  // `DispatchService.assignDriver` refuses every assignment with
  // NO_WAREHOUSE_FOR_GRADE regardless of how correct the rest of the seed is.
  await call('/warehouses', {
    method: 'POST',
    token: superAdmin.accessToken,
    body: {
      name: `Dashboard Warehouse ${suffix}`,
      location: STATION_LOCATION,
      addressText: 'Riyadh — seeded warehouse',
      region: REGION_CODE,
      governorate: GOVERNORATE_CODE,
      fuelTypes: ['DIESEL', 'PETROL_91', 'PETROL_95', 'KEROSENE'],
    },
  });
  console.log('✔ warehouse seeded');

  // 6. Drivers — the transporter's own fleet, never the Fuel Company's.
  // Feature 009 (spec 008 cutover): a vehicle is no longer a field embedded
  // on the driver. `CreateUserDto` for role DRIVER accepts no `truck` field
  // at all any more — the previous version of this script sent one and
  // would 400 on this exact call (`forbidNonWhitelisted: true`). Truck and
  // tank are now their own records, created and paired separately below.
  //
  // `DRIVER_COUNT` drivers, each with their own truck (paired card + qr
  // token) and own valid tank, so the transport dashboard has real fleet
  // depth to assign many concurrent orders against — one driver is enough
  // to prove the wiring, not enough to test assignment across a work queue.
  // `isOnline`/`location` are runtime presence state, never accepted by
  // `CreateUserDto` (`DispatchService.findCandidates`'s `$geoNear` silently
  // omits a driver with no location) — each driver is brought genuinely
  // online here via a real `/tracking` socket connection and one
  // `location:update`, the same protocol the mobile app itself uses, spread
  // a little around Riyadh so the map shows distinct points.
  const transportAdmin = await login({ email: transport.admin.email });

  // The transporter's own delivery price. WITHOUT THIS THE SEED CANNOT PLACE A
  // SINGLE ORDER: `TransportPricingService` refuses a quote outright when any
  // transporter serving the area has no rate on file
  // (`409 TRANSPORT_PRICE_NOT_SET`) rather than quietly skipping that company,
  // because the fuel company may route the order to exactly that transporter
  // and a price it never set is not a price. The rate moved onto the party that
  // performs the haul after this script was last updated, so every run since
  // then has died at the first `/orders/quote`.
  //
  // Written by the TRANSPORT admin: a fuel company may read what its
  // transporter charges but may never set it.
  await call(`/companies/${transportCompanyId}/delivery-rates`, {
    method: 'PUT',
    token: transportAdmin.accessToken,
    body: { rates: [{ regionCode: REGION_CODE, pricePerKm: 2.5, minPrice: 300 }] },
  });
  console.log(`✔ transporter delivery rate set for ${REGION_CODE}`);

  interface SeededDriver {
    id: string;
    phone: string;
    truckId: string;
    plateNumber: string;
    tankId: string;
  }
  const drivers: SeededDriver[] = [];

  for (let i = 0; i < DRIVER_COUNT; i++) {
    const driverPhone = `+9665500${suffix.slice(-4)}${i}`;
    const driverEmail = `driver${i}@${tag('dash')}.test`;
    const created = await call<{ _id: string }>('/users', {
      method: 'POST',
      token: transportAdmin.accessToken,
      body: {
        role: 'DRIVER',
        email: driverEmail,
        password: PASSWORD,
        fullName: `Dashboard Driver ${i + 1}`,
        phone: driverPhone,
      },
    });

    const plateNumber = `DSH-${suffix.slice(-4)}-${i}`;
    const truck = await call<{ id: string }>('/trucks', {
      method: 'POST',
      token: transportAdmin.accessToken,
      body: { plateNumber },
    });
    const nfcCardUid = `SEED-CARD-${suffix}-${i}`;
    await call(`/trucks/${truck.id}/pair-card`, {
      method: 'POST',
      token: transportAdmin.accessToken,
      body: { nfcCardUid },
    });
    await call(`/trucks/${truck.id}/qr-token`, { method: 'POST', token: transportAdmin.accessToken });

    const tank = await call<{ id: string }>('/tanks', {
      method: 'POST',
      token: transportAdmin.accessToken,
      body: {
        code: `TANK-OK-${suffix}-${i}`,
        material: i % 2 === 0 ? 'ALUMINIUM' : 'IRON',
        maxCapacityLiters: 30000,
        fuelTypes: ['DIESEL', 'PETROL_91', 'PETROL_95', 'KEROSENE'],
      },
    });

    // Bring the driver genuinely online with a real location — small jitter
    // per index so drivers don't all land on the exact same point.
    const driverAuth = await login({ email: driverEmail });
    await connectDriverOnline(driverAuth.accessToken, {
      lat: STATION_LOCATION.latitude + (i - DRIVER_COUNT / 2) * 0.01,
      lng: STATION_LOCATION.longitude + (i - DRIVER_COUNT / 2) * 0.01,
    });

    drivers.push({ id: created._id, phone: driverPhone, truckId: truck.id, plateNumber, tankId: tank.id });
    console.log(`✔ driver ${i + 1}/${DRIVER_COUNT} online — truck ${plateNumber}, tank ${tank.id}`);
    actors.push({
      role: 'DRIVER',
      login: driverPhone,
      password: PASSWORD,
      note: `delivers — logs in by PHONE — truck ${plateNumber}`,
    });
  }
  const driverPhone = drivers[0].phone;
  console.log(`✔ ${DRIVER_COUNT} drivers seeded, each online with its own truck + tank\n`);

  // 6b. One deliberately undersized, single-grade tank — matching
  // quickstart.md Part 2 record 11, the walkthrough's proof that the
  // assignment guards are real (SC-007). Shared, not per-driver: its only
  // job is to be chosen once and refused.
  const undersizedTank = await call<{ id: string }>('/tanks', {
    method: 'POST',
    token: transportAdmin.accessToken,
    body: {
      code: `TANK-UNDERSIZED-${suffix}`,
      material: 'IRON',
      maxCapacityLiters: 5000,
      fuelTypes: ['DIESEL'],
    },
  });
  console.log(`✔ deliberately undersized tank seeded — ${undersizedTank.id}\n`);

  // 7. spec 005 T129: `ORDER_COUNT` orders on the client's default station, so the
  // orders list/dashboard have something to page through locally, AND enough of a
  // work queue to actually test assigning many orders across `DRIVER_COUNT` drivers.
  // Left in PENDING_APPROVAL — walking each through the full lifecycle here would
  // duplicate what the e2e suites already cover, and pagination/list UI is this
  // step's own concern; `scripts/approve-and-route-order.ts` (or its `ALL` mode)
  // is the real approval/routing step. **DEFERRED, not DIRECT**: a DIRECT order
  // stops at PENDING_PAYMENT on approval and never reaches the transport admin's
  // queue at all (FR-020a) — since routing is exactly what this fleet exists to
  // test, DEFERRED (which routes immediately, no client credit setup required) is
  // the payment method that actually exercises it.
  const clientAuth = await login({ email: `client@${tag('dash')}.test` });
  const ordersFuelTypes = ['DIESEL', 'PETROL_91', 'PETROL_95'] as const;
  const clientStations = await call<{ items: { _id: string }[] }>('/stations', {
    method: 'GET',
    token: clientAuth.accessToken,
  });
  const seedStationId = clientStations.items[0]._id;
  for (let i = 0; i < ORDER_COUNT; i++) {
    const fuelType = ordersFuelTypes[i % ordersFuelTypes.length];
    const quote = await call<{ quoteToken: string }>('/orders/quote', {
      method: 'POST',
      token: clientAuth.accessToken,
      body: { fuelType, quantityLiters: 20000, stationId: seedStationId },
    });
    await call('/orders', {
      method: 'POST',
      token: clientAuth.accessToken,
      body: {
        fuelType,
        quantityLiters: 20000,
        stationId: seedStationId,
        quoteToken: quote.quoteToken,
        paymentMethod: 'DEFERRED',
      },
    });
  }
  console.log(`✔ ${ORDER_COUNT} orders seeded for the client (DEFERRED — ready to approve+route)\n`);

  // 8. Feature 013 T004/T005: a station owner holding a CREDIT LIMIT, at
  // least one APPROVED order for them, and the exact reference case
  // quickstart.md Part 2 uses (31,501.100 L supplied against 33,000 L
  // ordered) — so Phase 14's supplier-invoice/litre-balance walkthrough has
  // real data without hand-building it each run.
  await call(`/users/${client._id}/credit-limit`, {
    method: 'PUT',
    token: fuelAdmin.accessToken,
    body: { creditLimit: 500000 },
  });
  console.log('✔ credit limit set on the seeded client (500,000)');

  const referenceOrder = await (async () => {
    const quote = await call<{ quoteToken: string }>('/orders/quote', {
      method: 'POST',
      token: clientAuth.accessToken,
      body: { fuelType: 'DIESEL', quantityLiters: 33000, stationId: seedStationId },
    });
    return call<{ _id: string }>('/orders', {
      method: 'POST',
      token: clientAuth.accessToken,
      body: {
        fuelType: 'DIESEL',
        quantityLiters: 33000,
        stationId: seedStationId,
        quoteToken: quote.quoteToken,
        paymentMethod: 'DEFERRED',
      },
    });
  })();
  await call(`/orders/${referenceOrder._id}/approve`, {
    method: 'PATCH',
    token: fuelAdmin.accessToken,
    body: {},
  });
  console.log(`✔ reference-case order approved — ${referenceOrder._id} (33,000 L DIESEL, ready for a supplier invoice)`);

  // GET /orders takes only `status`/`cursor` — no page-size param — so this
  // reads the whole first PENDING_APPROVAL page and uses just the first row.
  const firstBatchOrders = await call<{ items: { _id: string; status: string }[] }>(
    `/orders?status=PENDING_APPROVAL`,
    { method: 'GET', token: fuelAdmin.accessToken },
  );
  if (firstBatchOrders.items[0]) {
    await call(`/orders/${firstBatchOrders.items[0]._id}/approve`, {
      method: 'PATCH',
      token: fuelAdmin.accessToken,
      body: {},
    });
    console.log(`✔ one seeded batch order approved — ${firstBatchOrders.items[0]._id} (invoice now exists, US6/US9 testable)`);
  }

  // 9. Feature 013 T004: a SECOND fuel company with its own administrator —
  // required by every isolation assertion this feature adds (SC-006) and by
  // Part 3's fuel exchange walkthrough, which needs two companies each
  // selling a grade the other can name in a request (FR-085).
  const registerPdfB = readFileSync(join(__dirname, 'fixtures', 'sample-register.pdf'));
  const formB = new FormData();
  formB.append('name', `Dashboard Fuel Co B ${suffix}`);
  formB.append('contactEmail', `contact@${tag('fuelb')}.test`);
  formB.append('contactPhone', `+9665${suffix}9`);
  formB.append('adminEmail', `fuelb@${tag('dash')}.test`);
  formB.append('adminFullName', 'Dashboard Fuel Admin B');
  formB.append('adminPhone', `+9665900${suffix.slice(-5)}`);
  formB.append('adminPassword', PASSWORD);
  formB.append(
    'commercialRegister',
    new Blob([new Uint8Array(registerPdfB)], { type: 'application/pdf' }),
    'register.pdf',
  );
  const fuelB = await call<{ company: { _id: string }; admin: { email: string } }>('/companies', {
    method: 'POST',
    token: superAdmin.accessToken,
    form: formB,
  });
  const fuelAdminB = await login({ email: fuelB.admin.email });
  await call(`/companies/${fuelB.company._id}/fuel-prices`, {
    method: 'PUT',
    token: fuelAdminB.accessToken,
    body: {
      prices: [
        { fuelType: 'DIESEL', basePricePerLiter: 2.05 },
        { fuelType: 'PETROL_91', basePricePerLiter: 2.3 },
        { fuelType: 'PETROL_95', basePricePerLiter: 2.5 },
        { fuelType: 'KEROSENE', basePricePerLiter: 1.9 },
      ],
    },
  });
  // Prices alone are not enough: the client app's create-order form draws its
  // quantity ladder from `tankerCapacitiesLiters`, so a company with prices and
  // no pricing config renders a fuel-type row with a quantity row that can
  // never offer anything. Company A gets this at step 5a; B needs it too.
  await call(`/companies/${fuelB.company._id}/pricing-config`, {
    method: 'PUT',
    token: fuelAdminB.accessToken,
    body: {
      deliveryFee: 30,
      serviceFeePercent: 1,
      taxRatePercent: 15,
      tankerCapacitiesLiters: [20000, 22000, 32000, 33000, 36000, 42000, 46000],
    },
  });
  console.log(`✔ second fuel company ${fuelB.company._id} seeded — for isolation tests and fuel exchange (Part 3)`);
  actors.push({
    role: 'FUEL_COMPANY_ADMIN (company B)',
    login: fuelB.admin.email,
    password: PASSWORD,
    note: 'the counterparty for isolation and fuel-exchange walkthroughs — SC-006, quickstart Part 3',
  });

  // ── spec 017 (operator dashboard) T002 — the quickstart Part 0 mix ─────────
  //
  // Everything below exists so the operator's screens have something TRUE to
  // show, and specifically so the distinctions this feature turns on are
  // visible rather than merely implemented:
  //
  //  · three fuel and five transport companies, so the company-type filter
  //    returns two different numbers (US2) and the overview's two counts differ;
  //  · orders across all six buckets — including the three the mock never had
  //    (AWAITING_ROUTING, REJECTED, CANCELLED) — so the six-segment chart has
  //    six segments and the NEEDS_ATTENTION card is not always zero;
  //  · orders RAISED in the period but never delivered, which is the ONLY way
  //    to see that the order count and the trading volume are counted on two
  //    different bases (FR-001a). Without these the two bases are
  //    indistinguishable and a wrong implementation looks right;
  //  · a never-connected driver, a driver never assigned a truck, and a driver
  //    with deliveries on two different trucks — the three roster cases
  //    FR-039a/FR-039b/FR-040 each distinguish;
  //  · an accrued cashback balance, so the payout screen has a real figure to
  //    pay down and the owed balance can be watched falling (FR-067).
  await seedOperatorMix(superAdmin.accessToken, fuelCompanyId, actors);

  writePostmanEnvironment({
    fuelAdminEmail: fuel.admin.email,
    transportAdminEmail: transport.admin.email,
    clientPhone,
    driverPhone,
    fuelAdminBEmail: fuelB.admin.email,
    referenceOrderId: referenceOrder._id,
  });

  console.log('Paste these into the dashboard session panel:\n');
  for (const a of actors) {
    console.log(`  ${a.role.padEnd(24)} ${a.login.padEnd(34)} ${a.password}`);
    console.log(`  ${''.padEnd(24)} ${a.note}\n`);
  }
  console.log(`Dashboard: ${BASE_URL.replace(/\/api\/v1$/, '')}/dashboard/`);
}


/**
 * spec 017 (operator dashboard) T002 — seeds the platform mix the operator's
 * quickstart walks over.
 *
 * Deliberately uses **this feature's own** `POST /companies/transporters`
 * route for the transporters it creates: seeding them through the route the
 * feature adds is a free, continuous check that the route works end to end,
 * and it is also what makes the FR-031 equivalence claim demonstrable by hand
 * — the fixture's pre-existing transporters were created the other way.
 */
async function seedOperatorMix(
  superAdminToken: string,
  firstFuelCompanyId: string,
  actors: Actor[],
): Promise<void> {
  const EXTRA_FUEL_COMPANIES = 1; // two already exist above ⇒ three in total
  const EXTRA_TRANSPORT_COMPANIES = 4; // one already exists ⇒ five in total

  const registerPdf = readFileSync(join(__dirname, 'fixtures', 'sample-register.pdf'));

  for (let i = 0; i < EXTRA_FUEL_COMPANIES; i += 1) {
    const form = new FormData();
    const label = `OperatorFuel${i + 1}-${suffix}`;
    form.append('name', label);
    form.append('contactEmail', `contact-${label.toLowerCase()}@platform.test`);
    form.append('contactPhone', `+96650${suffix}`);
    form.append('adminEmail', `admin-${label.toLowerCase()}@platform.test`);
    form.append('adminFullName', `${label} Admin`);
    form.append('adminPhone', `+9665200${String(i).padStart(5, '0')}`);
    form.append('adminPassword', PASSWORD);
    form.append(
      'commercialRegister',
      new Blob([new Uint8Array(registerPdf)], { type: 'application/pdf' }),
      'register.pdf',
    );
    await call('/companies', { method: 'POST', token: superAdminToken, form });
  }
  console.log(`✔ ${EXTRA_FUEL_COMPANIES} extra fuel company/companies — three on the platform in total`);

  for (let i = 0; i < EXTRA_TRANSPORT_COMPANIES; i += 1) {
    const label = `OperatorTransport${i + 1}-${suffix}`;
    await call('/companies/transporters', {
      method: 'POST',
      token: superAdminToken,
      body: {
        name: label,
        contactEmail: `contact-${label.toLowerCase()}@platform.test`,
        contactPhone: '+966500000002',
        // The field that makes this the OPERATOR's route rather than the fuel
        // company's: a SUPER_ADMIN has no tenant to take the parent from.
        parentFuelCompanyId: firstFuelCompanyId,
        adminEmail: `admin-${label.toLowerCase()}@platform.test`,
        adminFullName: `${label} Admin`,
        adminPhone: `+9665300${String(i).padStart(5, '0')}`,
        adminPassword: PASSWORD,
      },
    });
  }
  console.log(
    `✔ ${EXTRA_TRANSPORT_COMPANIES} transporters onboarded through POST /companies/transporters — five on the platform in total`,
  );

  actors.push({
    role: 'SUPER_ADMIN (operator surface)',
    login: SUPER_ADMIN_EMAIL,
    password: SUPER_ADMIN_PASSWORD,
    note: 'spec 017 — three fuel and five transport companies now exist, so ?type= returns two different counts',
  });

  console.log(
    [
      '',
      'spec 017 — the rest of the Part 0 mix needs direct database access and is',
      'NOT seeded over HTTP, because no route can produce it:',
      '',
      '  · orders parked in AWAITING_ROUTING / REJECTED / CANCELLED,',
      '  · orders raised inside the period but never delivered (FR-001a),',
      '  · a never-connected driver (no lastSeenAt) and a driver with',
      '    deliveries on two different trucks (FR-039a/FR-040),',
      '  · an accrued, confirmed CASHBACK_CREDITED balance (FR-067).',
      '',
      'Each is produced by the e2e suites that assert it —',
      'platform-overview, order-buckets, driver-roster and cashback-payout —',
      'which seed it directly and are the authoritative check. Reproduce it by',
      'hand with quickstart.md Part 0 when walking the screens.',
      '',
    ].join('\n'),
  );
}

main().catch((err: Error) => {
  console.error(`\nSeeding failed: ${err.message}`);
  process.exit(1);
});
