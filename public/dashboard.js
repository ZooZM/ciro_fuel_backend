/**
 * Ciro — order-cycle test dashboard (dev only).
 *
 * Drives the whole spec-004 order lifecycle against the live REST API with one
 * logged-in session per role, because almost every transition is performed by a
 * *different* actor than the one before it: CLIENT creates, FUEL_COMPANY_ADMIN
 * approves/routes, the payment gateway webhook settles a DIRECT order,
 * TRANSPORT_COMPANY_ADMIN assigns a driver, and the DRIVER closes the delivery
 * with two OTPs the CLIENT reads. Keeping five independent tokens in one page is
 * the whole point — it is what makes the cycle testable end to end.
 */

const ROLES = [
  'SUPER_ADMIN',
  'FUEL_COMPANY_ADMIN',
  'TRANSPORT_COMPANY_ADMIN',
  'CLIENT',
  'DRIVER',
];

const STATUSES = [
  'PENDING_APPROVAL',
  'APPROVED',
  'PENDING_PAYMENT',
  'AWAITING_ROUTING',
  'ROUTED_TO_TRANSPORT',
  'ASSIGNED_TO_DRIVER',
  'IN_TRANSIT',
  'UNLOADING',
  'DELIVERED',
  'REJECTED',
  'CANCELLED',
];

const STORE_KEY = 'ciro.order-cycle-dashboard.v1';

// A page opened straight off disk has origin "null", which would make the
// default base URL the literal string "null/api/v1". It is also unusable
// against this API for a second, independent reason — see the banner below.
const OPENED_FROM_DISK = location.protocol === 'file:';
const DEFAULT_BASE_URL = OPENED_FROM_DISK
  ? 'http://localhost:3000/api/v1'
  : `${location.origin}/api/v1`;

const state = {
  baseUrl: DEFAULT_BASE_URL,
  secrets: { SADAD: 'change-me', MADA: 'change-me' },
  sessions: {}, // role -> { identifier, password, accessToken, refreshToken, user }
  orders: new Map(), // id -> order (merged across sessions)
  visibility: new Map(), // id -> Set<role> that can currently read it
  candidates: new Map(), // orderId -> [{ id, name }] routing candidates
  drivers: [], // dispatch candidates for the selected order
  invoices: [],
  selectedId: null,
  // Detail-panel field values, kept outside the DOM so the 4s poll can re-render
  // the panel without eating a half-typed OTP or price.
  inputs: {},
  running: false,
  abortRun: false,
  socket: null,
};

for (const role of ROLES) state.sessions[role] = { identifier: '', password: '', accessToken: null, refreshToken: null, user: null };

// ── persistence ──────────────────────────────────────────────────────────────
// Dev convenience only: tokens live in localStorage so a page reload does not
// cost five logins. Never ship this file to a production origin.
function save() {
  const sessions = {};
  for (const role of ROLES) {
    const s = state.sessions[role];
    sessions[role] = {
      identifier: s.identifier, password: s.password,
      accessToken: s.accessToken, refreshToken: s.refreshToken, user: s.user,
    };
  }
  localStorage.setItem(STORE_KEY, JSON.stringify({ baseUrl: state.baseUrl, secrets: state.secrets, sessions }));
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    // Discard a base URL saved while the page was opened from disk — it was
    // built from origin "null" and can only ever fail.
    if (raw.baseUrl && !raw.baseUrl.startsWith('null')) state.baseUrl = raw.baseUrl;
    if (raw.secrets) Object.assign(state.secrets, raw.secrets);
    if (raw.sessions) for (const role of ROLES) if (raw.sessions[role]) Object.assign(state.sessions[role], raw.sessions[role]);
  } catch { /* corrupt state is not worth recovering — start clean */ }
}

// ── tiny DOM helpers ─────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (id) => (id ? String(id).slice(-6) : '—');
const val = (id) => $(id)?.value.trim() ?? '';
const setInput = (id, value) => { state.inputs[id] = String(value ?? ''); if ($(id)) $(id).value = state.inputs[id]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── logging ──────────────────────────────────────────────────────────────────
function log(kind, title, detail, isError = false) {
  const el = document.createElement('div');
  el.className = `entry${isError ? ' err' : ''}`;
  const time = new Date().toLocaleTimeString();
  el.innerHTML =
    `<div class="l1"><span class="muted">${time}</span><span class="pill ${isError ? 'err' : 'info'}">${esc(kind)}</span><span>${esc(title)}</span></div>` +
    (detail === undefined ? '' : `<pre>${esc(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2))}</pre>`);
  const box = $('log');
  box.prepend(el);
  while (box.children.length > 120) box.lastChild.remove();
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
class ApiError extends Error {
  constructor(status, body) {
    super(typeof body?.message === 'string' ? body.message : JSON.stringify(body?.message ?? body));
    this.status = status;
    this.body = body;
  }
}

/**
 * One request as `role`. On 401 it silently refreshes once and replays — the
 * same single-flight contract the mobile app and web dashboard use, so an
 * expired access token never shows up as a spurious lifecycle failure.
 */
async function api(role, method, path, body, opts = {}) {
  const session = state.sessions[role];
  if (!session?.accessToken && !opts.public) throw new Error(`${role} is not logged in`);

  const send = async () => {
    const headers = { ...(opts.headers || {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session?.accessToken && !opts.public) headers.Authorization = `Bearer ${session.accessToken}`;
    let res;
    try {
      res = await fetch(state.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : (opts.rawBody ?? JSON.stringify(body)),
      });
    } catch (cause) {
      // A rejected fetch never reached the API — the browser refused it. The
      // overwhelmingly common cause is running this page anywhere other than
      // the backend's own origin, where helmet's Cross-Origin-Resource-Policy
      // discards the response even though the request itself succeeds. Such a
      // request works perfectly in Postman, which enforces neither policy.
      throw new Error(
        `Could not reach ${state.baseUrl}${path} — the browser blocked it (network, CORS or CORP). ` +
        `Open this dashboard from the backend's own origin: ${state.baseUrl.replace(/\/api\/v1$/, '')}/dashboard/`,
      );
    }
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { res, parsed };
  };

  let { res, parsed } = await send();
  if (res.status === 401 && session?.refreshToken && !opts.public && !opts.noRetry) {
    const ok = await refreshSession(role);
    if (ok) ({ res, parsed } = await send());
  }

  const label = `${role} ${method} ${path}`;
  if (!res.ok) {
    log(res.status, label, parsed, true);
    throw new ApiError(res.status, parsed);
  }
  log(res.status, label, parsed);
  return parsed;
}

async function refreshSession(role) {
  const session = state.sessions[role];
  try {
    const res = await fetch(`${state.baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    if (!res.ok) return false;
    const tokens = await res.json();
    session.accessToken = tokens.accessToken;
    session.refreshToken = tokens.refreshToken;
    save();
    log('200', `${role} POST /auth/refresh`, 'token pair rotated');
    return true;
  } catch { return false; }
}

// ── auth ─────────────────────────────────────────────────────────────────────
async function login(role) {
  const session = state.sessions[role];
  session.identifier = val(`id-${role}`);
  session.password = val(`pw-${role}`);
  // Admins authenticate by email, CLIENT/DRIVER by E.164 phone — the DTO picks
  // phone whenever it is present, so send exactly one of the two.
  const credential = session.identifier.startsWith('+')
    ? { phone: session.identifier }
    : { email: session.identifier };

  const out = await api(role, 'POST', '/auth/login', { ...credential, password: session.password }, { public: true });
  session.accessToken = out.accessToken;
  session.refreshToken = out.refreshToken;
  session.user = out.user;
  save();
  renderSessions();
  await refreshOrders();
}

function logout(role) {
  const s = state.sessions[role];
  s.accessToken = s.refreshToken = s.user = null;
  if (role === 'DRIVER') disconnectSocket();
  save();
  renderSessions();
  refreshOrders();
}

const isLive = (role) => Boolean(state.sessions[role].accessToken);

// ── orders ───────────────────────────────────────────────────────────────────
async function refreshOrders() {
  const readers = ROLES.filter((r) => isLive(r) && r !== 'SUPER_ADMIN');
  if (!readers.length) { state.orders.clear(); state.visibility.clear(); render(); return; }

  const results = await Promise.allSettled(readers.map((role) => api(role, 'GET', '/orders')));
  const merged = new Map();
  const visibility = new Map();

  results.forEach((result, i) => {
    if (result.status !== 'fulfilled' || !Array.isArray(result.value)) return;
    for (const order of result.value) {
      const id = String(order._id);
      // Each role sees a different projection of the same order; last writer
      // wins on shared fields, which is fine — they only ever differ by which
      // optional fields the reader is allowed to see.
      merged.set(id, { ...(merged.get(id) || {}), ...order });
      if (!visibility.has(id)) visibility.set(id, new Set());
      visibility.get(id).add(readers[i]);
    }
  });

  state.orders = merged;
  state.visibility = visibility;
  if (state.selectedId && !merged.has(state.selectedId)) state.selectedId = null;
  render();
}

async function createOrder() {
  const body = {
    fuelType: val('fuelType'),
    quantityLiters: Number(val('qty')),
    paymentMethod: val('paymentMethod'),
  };
  const lat = val('lat'); const lng = val('lng');
  if (lat && lng) body.deliveryLocation = { latitude: Number(lat), longitude: Number(lng) };

  const order = await api('CLIENT', 'POST', '/orders', body);
  state.selectedId = String(order._id);
  await refreshOrders();
  return order;
}

// ── lifecycle actions ────────────────────────────────────────────────────────
async function approve(order) {
  const body = {};
  const price = val('in-finalPrice');
  if (price) body.finalPrice = Number(price);
  const transport = val('in-transportCompanyId');
  if (transport) body.transportCompanyId = transport;

  const out = await api('FUEL_COMPANY_ADMIN', 'PATCH', `/orders/${order._id}/approve`, body);
  // More than one transporter serves the client's region (FR-014): the API
  // hands back the candidate list and expects the admin to resubmit a choice.
  if (out.routingCandidates?.length) {
    state.candidates.set(String(order._id), out.routingCandidates);
    log('info', 'Routing needs a choice', out.routingCandidates);
  }
  await refreshOrders();
  return out;
}

const routeOrder = (order, transportCompanyId) =>
  api('FUEL_COMPANY_ADMIN', 'PATCH', `/orders/${order._id}/route`, { transportCompanyId }).then(afterAction);

const rejectOrder = (order) =>
  api('FUEL_COMPANY_ADMIN', 'PATCH', `/orders/${order._id}/reject`, { reason: val('in-reason') || 'Rejected from test dashboard' }).then(afterAction);

const cancelOrder = (order, role) =>
  api(role, 'PATCH', `/orders/${order._id}/cancel`, { reason: val('in-reason') || 'Cancelled from test dashboard' }).then(afterAction);

const redispatch = (order, role) =>
  api(role, 'POST', `/orders/${order._id}/redispatch`).then(afterAction);

const loadDriverCandidates = async (order) => {
  state.drivers = await api('TRANSPORT_COMPANY_ADMIN', 'GET', `/dispatch/orders/${order._id}/candidates`);
  render();
};

const assignDriver = (order, driverId) =>
  api('TRANSPORT_COMPANY_ADMIN', 'POST', `/dispatch/orders/${order._id}/assign`, { driverId }).then(afterAction);

const arrive = (order) => api('DRIVER', 'POST', `/orders/${order._id}/arrive`).then(afterAction);
const requestDeliveryOtp = (order) => api('DRIVER', 'POST', `/orders/${order._id}/request-delivery-otp`).then(afterAction);

// The client is the only party who ever sees the plaintext OTP — the driver
// build never renders it, so a real test must read it from the client session.
const peekOtp = async (order) => {
  const out = await api('CLIENT', 'GET', `/orders/${order._id}/otp/current`);
  setInput('in-otp', out.otp);
  return out.otp;
};

const verifyArrival = (order, otp) =>
  api('DRIVER', 'POST', `/orders/${order._id}/verify-arrival`, { otp }).then(afterAction);

const verifyDelivery = (order, otp) =>
  api('DRIVER', 'POST', `/orders/${order._id}/verify-delivery`, { otp }).then(afterAction);

const forceComplete = (order) =>
  api('FUEL_COMPANY_ADMIN', 'PATCH', `/orders/${order._id}/force-complete`, { reason: val('in-reason') || 'Force-completed from test dashboard' }).then(afterAction);

async function afterAction(result) {
  await refreshOrders();
  return result;
}

// ── payment webhook simulation ───────────────────────────────────────────────
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Stands in for Sadad/Mada. The backend HMACs the *raw* body, so the exact
 * string signed here has to be the exact string sent — hence the pre-serialized
 * payload rather than letting fetch stringify it again. Amount must equal
 * finalPrice to the cent or the event is recorded AMOUNT_MISMATCH.
 */
async function payWebhook(order, gateway = 'sadad') {
  const secret = state.secrets[gateway.toUpperCase()];
  const payload = JSON.stringify({
    transactionId: `dash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    orderId: String(order._id),
    amount: order.finalPrice,
    currency: 'SAR',
    status: 'PAID',
    paidAt: new Date().toISOString(),
  });
  const signature = await hmacHex(secret, payload);

  const res = await fetch(`${state.baseUrl}/payments/webhook/${gateway}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': signature },
    body: payload,
  });
  const out = await res.json().catch(() => null);
  const label = `GATEWAY POST /payments/webhook/${gateway}`;
  if (!res.ok) { log(res.status, label, out, true); throw new ApiError(res.status, out); }
  log(res.status, label, out);
  if (out?.accepted === false) log('warn', 'Webhook not accepted', 'Check the gateway secret and that amount === finalPrice.', true);
  await refreshOrders();
  return out;
}

// ── invoices ─────────────────────────────────────────────────────────────────
async function loadInvoices(role) {
  state.invoices = await api(role, 'GET', '/invoices');
  renderInvoices();
}

async function settleInvoice(invoiceId, role) {
  await api(role, 'POST', `/invoices/${invoiceId}/settle`, { paymentReference: `dash-${Date.now()}` });
  await loadInvoices(role);
  await refreshOrders();
}

// ── driver presence socket ───────────────────────────────────────────────────
// Presence is only ever set by the /tracking handshake, so a driver who never
// connects can never be assigned — this panel is what makes dispatch reachable.
function loadSocketIo() {
  if (window.io) return Promise.resolve(true);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = '/socket.io/socket.io.js';
    s.onload = () => resolve(Boolean(window.io));
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

async function connectSocket() {
  if (!isLive('DRIVER')) { log('warn', 'Driver socket', 'Log in as DRIVER first.', true); return; }
  if (!(await loadSocketIo())) { log('warn', 'Driver socket', 'socket.io client unavailable at /socket.io/socket.io.js', true); return; }

  disconnectSocket();
  const url = new URL(state.baseUrl);
  const socket = window.io(`${url.origin}/tracking`, {
    transports: ['websocket'],
    auth: { token: state.sessions.DRIVER.accessToken },
  });
  state.socket = socket;
  socket.on('connect', () => { renderSocket('connected'); log('ws', 'driver socket connected', socket.id); });
  socket.on('connect_error', (e) => { renderSocket('error'); log('ws', 'driver socket error', e.message, true); });
  socket.on('disconnect', (r) => { renderSocket('disconnected'); log('ws', 'driver socket disconnected', r); });
  renderSocket('connecting');
}

function disconnectSocket() {
  if (state.socket) { state.socket.disconnect(); state.socket = null; renderSocket('disconnected'); }
}

function sendLocation() {
  if (!state.socket?.connected) { log('warn', 'location:update', 'socket not connected', true); return; }
  const frame = { lat: Number(val('drvLat')), lng: Number(val('drvLng')), recordedAt: new Date().toISOString() };
  state.socket.emit('location:update', frame, (ack) => log('ws', 'location:update', ack, ack && ack.ok === false));
}

function renderSocket(status) {
  const cls = status === 'connected' ? 'ok' : status === 'error' ? 'err' : 'warn';
  $('socketState').innerHTML = `<span class="pill ${cls}">${esc(status)}</span>`;
}

// ── full-cycle runner ────────────────────────────────────────────────────────
const RUN_STEPS = [
  'Check sessions',
  'Driver goes online',
  'CLIENT creates order',
  'FUEL approves (final price + invoice)',
  'Settle DIRECT payment (webhook)',
  'Route to a transporter',
  'TRANSPORT assigns a driver',
  'DRIVER arrives (arrival OTP)',
  'CLIENT reads OTP → DRIVER verifies arrival',
  'DRIVER requests delivery OTP',
  'CLIENT reads OTP → DRIVER verifies delivery',
  'Settle DEFERRED/CREDIT invoice',
];

function renderSteps(marks = {}) {
  $('steps').innerHTML = RUN_STEPS.map((label, i) => {
    const st = marks[i] || '';
    const mark = st === 'done' ? '✔' : st === 'fail' ? '✕' : st === 'run' ? '▸' : st === 'skip' ? '–' : '·';
    return `<li class="${st}"><span class="mark">${mark}</span><span>${esc(label)}</span></li>`;
  }).join('');
}

/** Polls the order until `predicate` holds — several transitions land asynchronously. */
async function waitFor(orderId, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.abortRun) throw new Error('Run stopped');
    await refreshOrders();
    const order = state.orders.get(orderId);
    if (order && predicate(order)) return order;
    await sleep(1200);
  }
  throw new Error(`Timed out waiting on order ${short(orderId)}`);
}

async function runCycle() {
  if (state.running) return;
  state.running = true; state.abortRun = false;
  const marks = {};
  const step = async (i, fn) => {
    if (state.abortRun) throw new Error('Run stopped');
    marks[i] = 'run'; renderSteps(marks);
    try { const out = await fn(); marks[i] = 'done'; renderSteps(marks); return out; }
    catch (e) { marks[i] = 'fail'; renderSteps(marks); throw e; }
  };
  const skip = (i, why) => { marks[i] = 'skip'; renderSteps(marks); log('info', `Skipped: ${RUN_STEPS[i]}`, why); };
  renderSteps(marks);

  try {
    await step(0, async () => {
      const missing = ['CLIENT', 'FUEL_COMPANY_ADMIN', 'TRANSPORT_COMPANY_ADMIN', 'DRIVER'].filter((r) => !isLive(r));
      if (missing.length) throw new Error(`Not logged in: ${missing.join(', ')}`);
    });

    await step(1, async () => {
      if (!state.socket?.connected) { await connectSocket(); await sleep(1200); }
      if (!state.socket?.connected) throw new Error('Driver socket never connected — driver stays offline and unassignable');
      sendLocation();
    });

    const created = await step(2, createOrder);
    const orderId = String(created._id);
    state.selectedId = orderId;

    await step(3, async () => {
      const order = state.orders.get(orderId);
      if (!val('in-finalPrice')) setInput('in-finalPrice', order.estimatedPrice);
      await approve(order);
    });

    const afterApprove = state.orders.get(orderId);
    if (afterApprove.status === 'PENDING_PAYMENT') {
      await step(4, async () => {
        await payWebhook(state.orders.get(orderId));
        await waitFor(orderId, (o) => o.status !== 'PENDING_PAYMENT');
      });
    } else {
      skip(4, `paymentMethod=${afterApprove.paymentMethod} never enters PENDING_PAYMENT`);
    }

    await step(5, async () => {
      const order = await waitFor(orderId, (o) => ['AWAITING_ROUTING', 'ROUTED_TO_TRANSPORT'].includes(o.status));
      if (order.status === 'ROUTED_TO_TRANSPORT') return;
      // AWAITING_ROUTING means routing needs a human: either several
      // candidates (FR-014) or none serving the region (FR-016).
      const candidates = state.candidates.get(orderId) || [];
      if (!candidates.length) throw new Error('AWAITING_ROUTING with no candidates — no transporter serves this region');
      await routeOrder(order, candidates[0].id);
    });

    await step(6, async () => {
      const order = await waitFor(orderId, (o) => o.status === 'ROUTED_TO_TRANSPORT');
      const candidates = await api('TRANSPORT_COMPANY_ADMIN', 'GET', `/dispatch/orders/${orderId}/candidates`);
      const driverId = state.sessions.DRIVER.user?.id;
      const pick = candidates.find((c) => String(c._id ?? c.id) === driverId) || candidates[0];
      if (!pick) throw new Error('No eligible driver — check online/available state, truck capacity and fuel type');
      await assignDriver(order, String(pick._id ?? pick.id));
      await waitFor(orderId, (o) => o.status === 'IN_TRANSIT');
    });

    await step(7, () => arrive(state.orders.get(orderId)));
    await step(8, async () => {
      const otp = await peekOtp(state.orders.get(orderId));
      await verifyArrival(state.orders.get(orderId), otp);
      await waitFor(orderId, (o) => o.status === 'UNLOADING');
    });
    await step(9, () => requestDeliveryOtp(state.orders.get(orderId)));
    await step(10, async () => {
      const otp = await peekOtp(state.orders.get(orderId));
      await verifyDelivery(state.orders.get(orderId), otp);
      await waitFor(orderId, (o) => o.status === 'DELIVERED');
    });

    const delivered = state.orders.get(orderId);
    if (delivered.paymentMethod === 'DEFERRED' || delivered.paymentMethod === 'CREDIT') {
      await step(11, async () => {
        // DEFERRED is payable by the transporter, CREDIT by the fuel company
        // (FR-022/FR-023) — the other role is refused by design.
        const role = delivered.paymentMethod === 'DEFERRED' ? 'TRANSPORT_COMPANY_ADMIN' : 'FUEL_COMPANY_ADMIN';
        await loadInvoices(role);
        const invoice = state.invoices.find((i) => String(i.orderId) === orderId);
        if (!invoice) throw new Error('No invoice found for this order');
        await settleInvoice(String(invoice._id), role);
      });
    } else {
      skip(11, 'DIRECT invoices are settled by the webhook, not manually');
    }

    log('info', 'Full cycle complete', `Order ${short(orderId)} reached DELIVERED.`);
  } catch (e) {
    log('error', 'Cycle stopped', e.message, true);
  } finally {
    state.running = false;
    render();
  }
}

// ── rendering ────────────────────────────────────────────────────────────────
function renderSessions() {
  $('sessions').innerHTML = ROLES.map((role) => {
    const s = state.sessions[role];
    const live = Boolean(s.accessToken);
    return `
      <div class="session">
        <div class="head">
          <b>${role}</b>
          <span class="pill ${live ? 'ok' : ''}">${live ? 'live' : 'out'}</span>
        </div>
        ${live ? `<div class="who">${esc(s.user?.fullName || '')} · <span class="mono">${esc(s.user?.id || '')}</span></div>` : ''}
        <div class="field"><input id="id-${role}" placeholder="${role === 'CLIENT' || role === 'DRIVER' ? '+9665…' : 'email'}" value="${esc(s.identifier)}" /></div>
        <div class="field"><input id="pw-${role}" type="password" placeholder="password" value="${esc(s.password)}" /></div>
        <div class="actions" style="margin-top:0">
          <button data-login="${role}">${live ? 'Re-login' : 'Login'}</button>
          ${live ? `<button data-logout="${role}" class="danger">Logout</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

function renderBoard() {
  const grouped = new Map(STATUSES.map((s) => [s, []]));
  for (const order of state.orders.values()) {
    if (!grouped.has(order.status)) grouped.set(order.status, []);
    grouped.get(order.status).push(order);
  }

  $('board').innerHTML = STATUSES.map((status) => {
    const list = grouped.get(status) || [];
    const cards = list
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((o) => `
        <div class="card ${state.selectedId === String(o._id) ? 'sel' : ''}" data-order="${o._id}">
          <div class="id">#${short(o._id)}</div>
          <div>${esc(o.fuelType)} · ${esc(o.quantityLiters)}L</div>
          <div class="muted">${esc(o.paymentMethod)}${o.finalPrice ? ` · ${o.finalPrice} SAR` : ''}</div>
        </div>`).join('');
    return `<div class="col"><div class="title"><span>${status}</span><span>${list.length}</span></div>${cards}</div>`;
  }).join('');
}

/** Which actions the API will actually accept, given status + which roles are live. */
function availableActions(order) {
  const s = order.status;
  const acts = [];
  const add = (key, label, role, cls = '') => { if (isLive(role)) acts.push({ key, label, cls }); };

  if (s === 'PENDING_APPROVAL') {
    add('approve', 'Approve (final price)', 'FUEL_COMPANY_ADMIN', 'primary');
    add('reject', 'Reject', 'FUEL_COMPANY_ADMIN', 'danger');
  }
  if (s === 'PENDING_PAYMENT') {
    acts.push({ key: 'pay-sadad', label: 'Pay via SADAD webhook', cls: 'primary' });
    acts.push({ key: 'pay-mada', label: 'Pay via MADA webhook' });
  }
  if (s === 'APPROVED') add('redispatch', 'Redispatch (re-open payment)', 'FUEL_COMPANY_ADMIN');
  if (s === 'AWAITING_ROUTING') add('route', 'Route to transporter', 'FUEL_COMPANY_ADMIN', 'primary');
  if (s === 'ROUTED_TO_TRANSPORT') {
    add('candidates', 'Load driver candidates', 'TRANSPORT_COMPANY_ADMIN');
    add('assign', 'Assign driver', 'TRANSPORT_COMPANY_ADMIN', 'primary');
  }
  if (s === 'IN_TRANSIT') {
    add('arrive', 'Arrive (issue arrival OTP)', 'DRIVER', 'primary');
    add('peek-otp', 'Read OTP as client', 'CLIENT');
    add('verify-arrival', 'Verify arrival OTP', 'DRIVER');
  }
  if (s === 'UNLOADING') {
    add('delivery-otp', 'Request delivery OTP', 'DRIVER', 'primary');
    add('peek-otp', 'Read OTP as client', 'CLIENT');
    add('verify-delivery', 'Verify delivery OTP', 'DRIVER');
  }
  if (s === 'IN_TRANSIT' || s === 'UNLOADING') add('force-complete', 'Force-complete', 'FUEL_COMPANY_ADMIN', 'danger');
  if (['PENDING_APPROVAL', 'APPROVED', 'AWAITING_ROUTING', 'ROUTED_TO_TRANSPORT', 'PENDING_PAYMENT'].includes(s)) {
    add('cancel-client', 'Cancel as client', 'CLIENT', 'danger');
  }
  if (['PENDING_APPROVAL', 'APPROVED', 'AWAITING_ROUTING', 'ROUTED_TO_TRANSPORT', 'PENDING_PAYMENT', 'ASSIGNED_TO_DRIVER'].includes(s)) {
    add('cancel-admin', 'Cancel as fuel admin', 'FUEL_COMPANY_ADMIN', 'danger');
  }
  return acts;
}

function renderDetail() {
  const order = state.selectedId ? state.orders.get(state.selectedId) : null;
  if (!order) { $('detail').innerHTML = '<span class="muted">No order selected.</span>'; return; }

  const seenBy = [...(state.visibility.get(String(order._id)) || [])].join(', ') || '—';
  const history = (order.statusHistory || []).slice(-8).reverse()
    .map((h) => `<div class="mono muted">${esc(new Date(h.at).toLocaleTimeString())} ${esc(h.from)} → ${esc(h.to)} <span class="pill">${esc(h.actorRole)}</span>${h.manualOverride ? ' <span class="pill warn">override</span>' : ''}</div>`)
    .join('') || '<span class="muted">—</span>';

  const candidates = state.candidates.get(String(order._id)) || [];
  const rows = [
    ['id', `<span class="mono">${esc(order._id)}</span>`],
    ['status', `<span class="pill ${order.status === 'DELIVERED' ? 'ok' : ['REJECTED', 'CANCELLED'].includes(order.status) ? 'err' : 'info'}">${esc(order.status)}</span>`],
    ['fuel / qty', `${esc(order.fuelType)} · ${esc(order.quantityLiters)} L`],
    ['payment', `${esc(order.paymentMethod)}${order.paymentDeadline ? ` · deadline ${esc(new Date(order.paymentDeadline).toLocaleTimeString())}` : ''}${order.paymentTimeoutCount ? ` · timeouts ${order.paymentTimeoutCount}` : ''}`],
    ['price', `est ${esc(order.estimatedPrice)}${order.finalPrice ? ` · final ${esc(order.finalPrice)}` : ''} SAR`],
    ['invoice', order.invoiceId ? `<span class="mono">${esc(order.invoiceId)}</span>` : '—'],
    ['transporter', order.transportCompanyId ? `<span class="mono">${esc(order.transportCompanyId)}</span>` : '—'],
    ['driver', order.driverSummary ? `${esc(order.driverSummary.fullName)} · ${esc(order.driverSummary.plateNumber)} · ${esc(order.driverSummary.phone)}` : '—'],
    ['eta', order.etaMinutes != null ? `${esc(order.etaMinutes)} min` : '—'],
    ['address', esc(order.deliveryAddressText || '—')],
    ['visible to', esc(seenBy)],
    ['reason', esc(order.rejectionReason || order.cancellationReason || '—')],
  ];

  $('detail').innerHTML = `
    <table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
    <h3>Recent transitions</h3>${history}
    <div class="inputs">
      <div><label for="in-finalPrice">finalPrice</label><input id="in-finalPrice" value="${esc(state.inputs['in-finalPrice'] ?? order.finalPrice ?? '')}" /></div>
      <div>
        <label for="in-transportCompanyId">transportCompanyId</label>
        ${candidates.length
          ? `<select id="in-transportCompanyId">${candidates.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>`
          : `<input id="in-transportCompanyId" value="${esc(state.inputs['in-transportCompanyId'] ?? '')}" placeholder="only when routing is ambiguous" />`}
      </div>
      <div>
        <label for="in-driverId">driverId</label>
        ${state.drivers.length
          ? `<select id="in-driverId">${state.drivers.map((d) => `<option value="${esc(d._id ?? d.id)}">${esc(d.fullName || d._id)} · ${esc(d.truck?.plateNumber || '')}</option>`).join('')}</select>`
          : `<input id="in-driverId" value="${esc(state.inputs['in-driverId'] ?? '')}" placeholder="load candidates first" />`}
      </div>
      <div><label for="in-otp">otp</label><input id="in-otp" value="${esc(state.inputs['in-otp'] ?? '')}" placeholder="read as client" /></div>
      <div><label for="in-reason">reason</label><input id="in-reason" value="${esc(state.inputs['in-reason'] ?? '')}" placeholder="reject / cancel / override" /></div>
    </div>
    <div class="actions">
      ${availableActions(order).map((a) => `<button class="${a.cls}" data-act="${a.key}">${esc(a.label)}</button>`).join('') || '<span class="muted">No action available for this status with the sessions you have.</span>'}
    </div>`;
}

function renderInvoices() {
  if (!state.invoices.length) { $('invoices').innerHTML = '<span class="muted">No invoices.</span>'; return; }
  $('invoices').innerHTML = `<table class="kv">${state.invoices.map((i) => `
    <tr>
      <td><span class="mono">#${short(i._id)}</span><br /><span class="muted">order #${short(i.orderId)}</span></td>
      <td>
        <span class="pill ${i.state === 'SETTLED' ? 'ok' : 'warn'}">${esc(i.state)}</span>
        <span class="pill">${esc(i.method)}</span> ${esc(i.amount)} SAR
        ${i.state !== 'SETTLED' && i.method !== 'DIRECT'
          ? `<button data-settle="${i._id}" data-settle-role="${i.method === 'DEFERRED' ? 'TRANSPORT_COMPANY_ADMIN' : 'FUEL_COMPANY_ADMIN'}" style="margin-inline-start:6px">Settle</button>`
          : ''}
      </td>
    </tr>`).join('')}</table>`;
}

function render() {
  renderBoard();
  // Re-rendering the panel would blur whatever is being typed in it, so the
  // poll leaves it alone while it has focus.
  if (!$('detail').contains(document.activeElement)) renderDetail();
  $('runCycle').disabled = state.running;
  $('stopCycle').disabled = !state.running;
}

// ── events ───────────────────────────────────────────────────────────────────
function guard(fn) {
  return (...args) => Promise.resolve(fn(...args)).catch((e) => log('error', 'Request failed', e.message, true));
}

document.addEventListener('input', (ev) => {
  const id = ev.target.id;
  if (id?.startsWith('in-')) state.inputs[id] = ev.target.value;
});

document.addEventListener('click', guard(async (ev) => {
  const t = ev.target.closest('button');
  if (!t) {
    const card = ev.target.closest('.card');
    if (card) { state.selectedId = card.dataset.order; state.drivers = []; render(); }
    return;
  }

  if (t.dataset.login) return login(t.dataset.login);
  if (t.dataset.logout) return logout(t.dataset.logout);
  if (t.dataset.invRole) return loadInvoices(t.dataset.invRole);
  if (t.dataset.settle) return settleInvoice(t.dataset.settle, t.dataset.settleRole);

  const act = t.dataset.act;
  if (!act) return;
  const order = state.orders.get(state.selectedId);
  if (!order) return;

  switch (act) {
    case 'approve': return approve(order);
    case 'reject': return rejectOrder(order);
    case 'route': return routeOrder(order, val('in-transportCompanyId'));
    case 'redispatch': return redispatch(order, 'FUEL_COMPANY_ADMIN');
    case 'pay-sadad': return payWebhook(order, 'sadad');
    case 'pay-mada': return payWebhook(order, 'mada');
    case 'candidates': return loadDriverCandidates(order);
    case 'assign': return assignDriver(order, val('in-driverId'));
    case 'arrive': return arrive(order);
    case 'peek-otp': return peekOtp(order);
    case 'verify-arrival': return verifyArrival(order, val('in-otp'));
    case 'delivery-otp': return requestDeliveryOtp(order);
    case 'verify-delivery': return verifyDelivery(order, val('in-otp'));
    case 'force-complete': return forceComplete(order);
    case 'cancel-client': return cancelOrder(order, 'CLIENT');
    case 'cancel-admin': return cancelOrder(order, 'FUEL_COMPANY_ADMIN');
  }
}));

$('createOrder').addEventListener('click', guard(createOrder));
$('refreshBtn').addEventListener('click', guard(refreshOrders));
$('runCycle').addEventListener('click', guard(runCycle));
$('stopCycle').addEventListener('click', () => { state.abortRun = true; });
$('sockConnect').addEventListener('click', guard(connectSocket));
$('sockLocate').addEventListener('click', sendLocation);
$('sockDisconnect').addEventListener('click', disconnectSocket);
$('clearLog').addEventListener('click', () => { $('log').innerHTML = ''; });
$('resetBtn').addEventListener('click', () => { localStorage.removeItem(STORE_KEY); location.reload(); });

$('baseUrl').addEventListener('change', (e) => { state.baseUrl = e.target.value.trim(); save(); });
$('sadadSecret').addEventListener('change', (e) => { state.secrets.SADAD = e.target.value; save(); });
$('madaSecret').addEventListener('change', (e) => { state.secrets.MADA = e.target.value; save(); });

// ── boot ─────────────────────────────────────────────────────────────────────
// Proves to the user that this file actually executed.
$('bootWarning')?.remove();

if (OPENED_FROM_DISK) {
  const banner = document.createElement('div');
  banner.style.cssText = 'background:#5c1f1f;color:#ffdada;padding:10px 14px;border-bottom:1px solid #8a3030;font-size:12.5px';
  banner.innerHTML =
    '<b>Opened from disk — logins cannot work here.</b> This page is served by the backend: open ' +
    '<a href="http://localhost:3000/dashboard/" style="color:#fff">http://localhost:3000/dashboard/</a> instead. ' +
    'A <span class="mono">file://</span> page is a different origin, and helmet sends ' +
    '<span class="mono">Cross-Origin-Resource-Policy: same-origin</span>, so the browser throws away every API response ' +
    '(the same request still succeeds in Postman, which ignores that policy).';
  document.body.prepend(banner);
}

load();
$('baseUrl').value = state.baseUrl;
$('sadadSecret').value = state.secrets.SADAD;
$('madaSecret').value = state.secrets.MADA;
renderSessions();
renderSteps();
render();
refreshOrders().catch(() => {});

setInterval(() => {
  if ($('pollToggle').checked && !state.running) refreshOrders().catch(() => {});
}, 4000);
