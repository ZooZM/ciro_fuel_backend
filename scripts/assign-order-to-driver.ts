/**
 * Manual test helper: creates one order and drives it all the way to
 * ASSIGNED_TO_DRIVER for a specific, already-existing driver — so you can
 * open the mobile app on that driver's account and see a real order land.
 *
 * Uses `paymentMethod: DEFERRED` (spec 004 FR-021) so the order routes
 * immediately at approval instead of parking in PENDING_PAYMENT — no webhook
 * to simulate.
 *
 * Creates whatever the driver's Transportation Company is missing to receive
 * an assignment (an active Truck, an active Tank sized/graded for the order,
 * a supplying Warehouse) — everything else (fuel company, transport company,
 * client, the driver itself) must already exist; this script only threads an
 * order through them.
 *
 * All identifiers are read from env vars so it can target whatever you
 * already have seeded, rather than a fixed fixture set:
 *
 *   BASE_URL              default http://localhost:3000/api/v1
 *   SUPER_ADMIN_EMAIL     default owner@example.com
 *   SUPER_ADMIN_PASSWORD  default change-me-please-16chars
 *   FUEL_ADMIN_EMAIL      default admin@smoketest.example
 *   FUEL_ADMIN_PASSWORD   default Password123!
 *   TRANSPORT_ADMIN_EMAIL default transportadmin@smoketest.example
 *   TRANSPORT_ADMIN_PASSWORD default Password123!
 *   CLIENT_EMAIL          default client@smoketest.example
 *   CLIENT_PASSWORD       default Password123!
 *   DRIVER_PHONE          default +966500000003 (E.164, must match the target driver)
 *   FUEL_TYPE             default DIESEL
 *   QUANTITY_LITERS       default 5000
 *
 *   npm run assign:driver-order
 *   DRIVER_PHONE=+9665... FUEL_TYPE=PETROL_95 npm run assign:driver-order
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000/api/v1';

const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL ?? 'owner@example.com';
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD ?? 'change-me-please-16chars';
const FUEL_ADMIN_EMAIL = process.env.FUEL_ADMIN_EMAIL ?? 'admin@smoketest.example';
const FUEL_ADMIN_PASSWORD = process.env.FUEL_ADMIN_PASSWORD ?? 'Password123!';
const TRANSPORT_ADMIN_EMAIL = process.env.TRANSPORT_ADMIN_EMAIL ?? 'transportadmin@smoketest.example';
const TRANSPORT_ADMIN_PASSWORD = process.env.TRANSPORT_ADMIN_PASSWORD ?? 'Password123!';
const CLIENT_EMAIL = process.env.CLIENT_EMAIL ?? 'client@smoketest.example';
const CLIENT_PASSWORD = process.env.CLIENT_PASSWORD ?? 'Password123!';
const DRIVER_PHONE = process.env.DRIVER_PHONE ?? '+966500000003';
const FUEL_TYPE = process.env.FUEL_TYPE ?? 'DIESEL';
const QUANTITY_LITERS = Number(process.env.QUANTITY_LITERS ?? '5000');

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

const login = (credential: { email?: string; phone?: string; password: string }) =>
  call<{ accessToken: string }>('/auth/login', { method: 'POST', body: credential });

async function main(): Promise<void> {
  console.log(`Targeting ${BASE_URL}, driver ${DRIVER_PHONE}\n`);

  const [superAdmin, fuelAdmin, transportAdmin, client] = await Promise.all([
    login({ email: SUPER_ADMIN_EMAIL, password: SUPER_ADMIN_PASSWORD }),
    login({ email: FUEL_ADMIN_EMAIL, password: FUEL_ADMIN_PASSWORD }),
    login({ email: TRANSPORT_ADMIN_EMAIL, password: TRANSPORT_ADMIN_PASSWORD }),
    login({ email: CLIENT_EMAIL, password: CLIENT_PASSWORD }),
  ]);
  console.log('✔ logged in as super admin, fuel admin, transport admin, client');

  // The driver must belong to the acting transport admin's own company and
  // currently be reachable (online, available, not already on a job) — the
  // exact predicate DispatchService.findCandidates uses.
  const drivers = await call<
    Array<{ _id: string; phone: string; isOnline: boolean; isAvailable: boolean; activeOrderId?: string }>
  >(`/users?role=DRIVER`, { method: 'GET', token: transportAdmin.accessToken });
  const targetDriver = drivers.find((d) => d.phone === DRIVER_PHONE);
  if (!targetDriver) {
    throw new Error(
      `No DRIVER with phone ${DRIVER_PHONE} found under the transport admin's own company — check DRIVER_PHONE/TRANSPORT_ADMIN_EMAIL`,
    );
  }
  if (!targetDriver.isOnline || !targetDriver.isAvailable || targetDriver.activeOrderId) {
    console.warn(
      `⚠ driver isOnline=${targetDriver.isOnline} isAvailable=${targetDriver.isAvailable} activeOrderId=${targetDriver.activeOrderId ?? 'none'} — assignment will fail until the driver's app connects the /tracking socket and is free`,
    );
  }
  console.log(`✔ driver ${targetDriver._id} located`);

  // Ensure an active truck exists for this transporter.
  const trucks = await call<{ items: Array<{ id: string; isActive: boolean; activeOrderId: string | null }> }>(
    '/trucks?available=true',
    { method: 'GET', token: transportAdmin.accessToken },
  );
  let truckId = trucks.items[0]?.id;
  if (!truckId) {
    const truck = await call<{ id: string }>('/trucks', {
      method: 'POST',
      token: transportAdmin.accessToken,
      body: { plateNumber: `TEST-${Date.now().toString().slice(-4)}` },
    });
    truckId = truck.id;
    console.log(`✔ created truck ${truckId}`);
  } else {
    console.log(`✔ reusing truck ${truckId}`);
  }

  // Ensure an active tank exists, sized and graded for this order.
  const tanks = await call<{
    items: Array<{ id: string; isActive: boolean; activeOrderId?: string | null; maxCapacityLiters: number; fuelTypes: string[] }>;
  }>('/tanks', { method: 'GET', token: transportAdmin.accessToken });
  let tankId = tanks.items.find(
    (t) => t.isActive && !t.activeOrderId && t.maxCapacityLiters >= QUANTITY_LITERS && t.fuelTypes.includes(FUEL_TYPE),
  )?.id;
  if (!tankId) {
    const tank = await call<{ id: string }>('/tanks', {
      method: 'POST',
      token: transportAdmin.accessToken,
      body: {
        code: `TEST-TANK-${Date.now().toString().slice(-4)}`,
        material: 'IRON',
        maxCapacityLiters: Math.max(QUANTITY_LITERS, 10000),
        fuelTypes: ['DIESEL', 'PETROL_91', 'PETROL_95', 'KEROSENE'],
      },
    });
    tankId = tank.id;
    console.log(`✔ created tank ${tankId}`);
  } else {
    console.log(`✔ reusing tank ${tankId}`);
  }

  // Fetch the client's default station — determines delivery region/location.
  const stations = await call<{
    items: Array<{
      _id: string;
      regionCode: string;
      governorateCode: string;
      location: { coordinates: [number, number] };
    }>;
  }>('/stations', { method: 'GET', token: client.accessToken });
  const station = stations.items[0];
  if (!station) {
    throw new Error('Client has no station on file — cannot place an order without one');
  }

  // Ensure a warehouse supplies this fuel type — dispatch's nearest-supplier
  // lookup has no distance cap, so any active, correctly-graded warehouse
  // anywhere satisfies it (WarehousesService.findNearestSupplying).
  const warehouses = await call<{ items: Array<{ fuelTypes: string[]; isActive: boolean }> }>(
    '/warehouses',
    { method: 'GET', token: transportAdmin.accessToken },
  );
  const hasSupplier = warehouses.items.some((w) => w.isActive && w.fuelTypes.includes(FUEL_TYPE));
  if (!hasSupplier) {
    await call('/warehouses', {
      method: 'POST',
      token: superAdmin.accessToken,
      body: {
        name: `Test Warehouse ${Date.now().toString().slice(-4)}`,
        location: {
          longitude: station.location.coordinates[0],
          latitude: station.location.coordinates[1],
        },
        addressText: 'Manual test warehouse',
        region: station.regionCode,
        governorate: station.governorateCode,
        fuelTypes: ['DIESEL', 'PETROL_91', 'PETROL_95', 'KEROSENE'],
      },
    });
    console.log(`✔ created warehouse supplying ${station.regionCode}`);
  } else {
    console.log('✔ a warehouse already supplies this region/grade');
  }

  // Quote, then create the order — DEFERRED so it routes immediately at approval.
  const quote = await call<{ quoteToken: string }>('/orders/quote', {
    method: 'POST',
    token: client.accessToken,
    body: { fuelType: FUEL_TYPE, quantityLiters: QUANTITY_LITERS, stationId: station._id },
  });
  const order = await call<{ _id: string; status: string }>('/orders', {
    method: 'POST',
    token: client.accessToken,
    body: {
      fuelType: FUEL_TYPE,
      quantityLiters: QUANTITY_LITERS,
      stationId: station._id,
      quoteToken: quote.quoteToken,
      paymentMethod: 'DEFERRED',
    },
  });
  console.log(`✔ order ${order._id} created`);

  // Approve — routes immediately to the sole serving transporter (DEFERRED).
  const approved = await call<{ status: string }>(`/orders/${order._id}/approve`, {
    method: 'PATCH',
    token: fuelAdmin.accessToken,
    body: {},
  });
  console.log(`✔ order approved → ${approved.status}`);
  if (approved.status !== 'ROUTED_TO_TRANSPORT') {
    throw new Error(
      `Order is ${approved.status}, not ROUTED_TO_TRANSPORT — check that exactly one transporter serves region ${station.regionCode}`,
    );
  }

  // Confirm the target driver actually shows up as a candidate.
  const candidates = await call<Array<{ _id: string }>>(`/dispatch/orders/${order._id}/candidates`, {
    method: 'GET',
    token: transportAdmin.accessToken,
  });
  if (!candidates.some((c) => c._id === targetDriver._id)) {
    throw new Error(
      `Driver ${DRIVER_PHONE} is not among the candidates for this order — is their app connected to /tracking and marked available?`,
    );
  }

  const assigned = await call<{ assigned: boolean; driverId: string }>(`/dispatch/orders/${order._id}/assign`, {
    method: 'POST',
    token: transportAdmin.accessToken,
    body: { driverId: targetDriver._id, truckId, tankId },
  });

  console.log('\n✔ assigned — check the driver app now\n');
  console.log(`  orderId   ${order._id}`);
  console.log(`  driverId  ${assigned.driverId}`);
  console.log(`  status    ASSIGNED_TO_DRIVER`);
}

main().catch((err: Error) => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});
