import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { ErrorCode } from '../../src/common/enums/error-code.enum';
import { Tank, TankDocument } from '../../src/modules/tanks/schemas/tank.schema';

jest.setTimeout(120_000);

/**
 * spec 008 US1 (T053-T057): registering a fleet — the truck/tank split, the
 * uniqueness rules that hold it together, and the two secrecy properties
 * that make the rest of the feature safe.
 *
 * The credential tests here are the load-bearing ones. FR-042 is satisfied
 * by responses that *omit* fields, and FR-048c by a schema that *lacks*
 * them — both are properties of what does not exist, so nothing but a test
 * keeps them true. A future hand adding `nfcCardUid` to a tank, or dropping
 * `toSafeShape` from one truck response, breaks a security boundary while
 * every other test in the suite stays green.
 */
describe('Fleet registration — trucks, tanks, credentials (spec 008 US1)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    server = app.getHttpServer();
    fixtures = await seedTwoCompanies(app);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  const adminA = () => fixtures.companyA.transportAdmin.token;
  const adminB = () => fixtures.companyB.transportAdmin.token;

  // --- T053 -----------------------------------------------------------

  it('registers trucks and tanks, and a truck carries no capacity or grade of its own (FR-048/R3)', async () => {
    const truckRes = await request(server)
      .post('/api/v1/trucks')
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ plateNumber: 'FLEET-T053-A', model: 'Volvo FH' })
      .expect(201);

    // R3: capability moved to the tank wholesale. A truck that still carried
    // a capacity would mean two answers to one question at assignment time.
    expect(truckRes.body).not.toHaveProperty('maxCapacityLiters');
    expect(truckRes.body).not.toHaveProperty('fuelTypes');
    expect(truckRes.body).toMatchObject({ plateNumber: 'FLEET-T053-A', isActive: true });

    const tankRes = await request(server)
      .post('/api/v1/tanks')
      .set('Authorization', `Bearer ${adminA()}`)
      .send({
        code: 'FLEET-T053-TANK',
        material: 'IRON',
        maxCapacityLiters: 30_000,
        fuelTypes: ['DIESEL', 'PETROL_91'],
      })
      .expect(201);
    expect(tankRes.body).toMatchObject({
      code: 'FLEET-T053-TANK',
      material: 'IRON',
      maxCapacityLiters: 30_000,
    });

    const list = await request(server)
      .get('/api/v1/trucks')
      .set('Authorization', `Bearer ${adminA()}`)
      .expect(200);
    expect(list.body.fleetRegistered).toBe(true);
    expect(list.body.items.map((t: { plateNumber: string }) => t.plateNumber)).toContain(
      'FLEET-T053-A',
    );

    const tankList = await request(server)
      .get('/api/v1/tanks')
      .set('Authorization', `Bearer ${adminA()}`)
      .expect(200);
    expect(tankList.body.items.map((t: { code: string }) => t.code)).toContain('FLEET-T053-TANK');
  });

  it('refuses a duplicate plate within the company, and a duplicate tank code platform-wide (FR-048b)', async () => {
    await request(server)
      .post('/api/v1/trucks')
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ plateNumber: 'FLEET-DUP' })
      .expect(201);
    await request(server)
      .post('/api/v1/trucks')
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ plateNumber: 'FLEET-DUP' })
      .expect(409)
      .then((res) => expect(res.body.error).toBe(ErrorCode.DUPLICATE_PLATE));

    // A plate is unique per company, not platform-wide — two carriers may
    // legitimately operate vehicles the registry numbers the same way.
    await request(server)
      .post('/api/v1/trucks')
      .set('Authorization', `Bearer ${adminB()}`)
      .send({ plateNumber: 'FLEET-DUP' })
      .expect(201);

    const tank = {
      code: 'FLEET-DUP-TANK',
      material: 'ALUMINIUM',
      maxCapacityLiters: 20_000,
      fuelTypes: ['DIESEL'],
    };
    await request(server)
      .post('/api/v1/tanks')
      .set('Authorization', `Bearer ${adminA()}`)
      .send(tank)
      .expect(201);
    // A tank code IS platform-wide (FR-048b) — it reaches a driver's screen
    // (FR-033a), where two tanks answering to one code would be ambiguous.
    await request(server)
      .post('/api/v1/tanks')
      .set('Authorization', `Bearer ${adminB()}`)
      .send(tank)
      .expect(409)
      .then((res) => expect(res.body.error).toBe(ErrorCode.TANK_CODE_IN_USE));
  });

  // --- T054 -----------------------------------------------------------

  it('refuses a card already paired elsewhere and leaves BOTH trucks unchanged (FR-005, SC-008)', async () => {
    const cardUid = 'CARD-SHARED-T054';
    const first = await request(server)
      .post('/api/v1/trucks')
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ plateNumber: 'FLEET-T054-1' })
      .expect(201);
    const second = await request(server)
      .post('/api/v1/trucks')
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ plateNumber: 'FLEET-T054-2' })
      .expect(201);

    await request(server)
      .post(`/api/v1/trucks/${first.body.id}/pair-card`)
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ nfcCardUid: cardUid })
      .expect(201);

    const conflict = await request(server)
      .post(`/api/v1/trucks/${second.body.id}/pair-card`)
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ nfcCardUid: cardUid })
      .expect(409);
    expect(conflict.body.error).toBe(ErrorCode.CARD_ALREADY_PAIRED);
    // spec 009 FR-050: the operator is told which tractor holds it, so the
    // card can be found rather than merely declared unavailable.
    expect(conflict.body.heldByPlateNumber).toBe('FLEET-T054-1');

    // "Leaves both unchanged" is the half a duplicate-key catch could
    // silently get wrong: the loser must not end up card-less, and the
    // holder must not have been reassigned.
    await request(server)
      .get(`/api/v1/trucks/${first.body.id}`)
      .set('Authorization', `Bearer ${adminA()}`)
      .expect(200)
      .then((res) => expect(res.body.hasCard).toBe(true));
    await request(server)
      .get(`/api/v1/trucks/${second.body.id}`)
      .set('Authorization', `Bearer ${adminA()}`)
      .expect(200)
      .then((res) => expect(res.body.hasCard).toBe(false));
  });

  it('a minted code coexists with the card, and re-pairing a card invalidates the code (FR-036d, FR-036e)', async () => {
    const created = await request(server)
      .post('/api/v1/trucks')
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ plateNumber: 'FLEET-T054-3' })
      .expect(201);
    const truckId = created.body.id;

    await request(server)
      .post(`/api/v1/trucks/${truckId}/pair-card`)
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ nfcCardUid: 'CARD-T054-3' })
      .expect(201);

    const minted = await request(server)
      .post(`/api/v1/trucks/${truckId}/qr-token`)
      .set('Authorization', `Bearer ${adminA()}`)
      .expect(201);
    // FR-036d: the code is an ALTERNATIVE for a driver whose device cannot
    // read NFC, not a replacement for the card. Minting must not disturb it.
    expect(minted.body.hasCard).toBe(true);
    expect(minted.body.hasCode).toBe(true);
    expect(typeof minted.body.qrToken).toBe('string');

    // FR-036e: a card replacement supersedes the credential set. A code
    // minted against the old card must stop working, or revoking a card by
    // replacing it would leave a live back door.
    const repaired = await request(server)
      .post(`/api/v1/trucks/${truckId}/pair-card`)
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ nfcCardUid: 'CARD-T054-3-REPLACED' })
      .expect(201);
    expect(repaired.body.hasCard).toBe(true);
    expect(repaired.body.hasCode).toBe(false);
  });

  // --- T055 -----------------------------------------------------------

  it("another company's truck or tank is 404, never 403 (FR-003, FR-048d, SC-011)", async () => {
    // 403 would confirm the id names something real. Across a tenant
    // boundary the only safe answer is the one non-existence gives.
    await request(server)
      .get(`/api/v1/trucks/${fixtures.companyA.truck.id}`)
      .set('Authorization', `Bearer ${adminB()}`)
      .expect(404);
    await request(server)
      .get(`/api/v1/tanks/${fixtures.companyA.tank.id}`)
      .set('Authorization', `Bearer ${adminB()}`)
      .expect(404);

    // Writes are scoped by the same plugin, not merely the reads.
    await request(server)
      .patch(`/api/v1/trucks/${fixtures.companyA.truck.id}/withdraw`)
      .set('Authorization', `Bearer ${adminB()}`)
      .expect(404);
    await request(server)
      .post(`/api/v1/trucks/${fixtures.companyA.truck.id}/pair-card`)
      .set('Authorization', `Bearer ${adminB()}`)
      .send({ nfcCardUid: 'CARD-CROSS-TENANT' })
      .expect(404);

    // And the neighbour's fleet never leaks through a list.
    const list = await request(server)
      .get('/api/v1/trucks')
      .set('Authorization', `Bearer ${adminB()}`)
      .expect(200);
    expect(list.body.items.map((t: { id: string }) => t.id)).not.toContain(
      fixtures.companyA.truck.id,
    );
  });

  // --- T056 -----------------------------------------------------------

  it('no truck read anywhere returns a raw credential; only minting does (FR-042)', async () => {
    const created = await request(server)
      .post('/api/v1/trucks')
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ plateNumber: 'FLEET-T056' })
      .expect(201);
    const truckId = created.body.id;
    await request(server)
      .post(`/api/v1/trucks/${truckId}/pair-card`)
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ nfcCardUid: 'CARD-T056-SECRET' })
      .expect(201);
    await request(server)
      .post(`/api/v1/trucks/${truckId}/qr-token`)
      .set('Authorization', `Bearer ${adminA()}`)
      .expect(201);

    // Every shape a truck can be read through — create, list, detail,
    // update, withdraw, restore, revoke. A stored credential that leaks
    // through any one of them is a harvestable key to a vehicle.
    const reads = [
      await request(server)
        .get('/api/v1/trucks')
        .set('Authorization', `Bearer ${adminA()}`)
        .expect(200),
      await request(server)
        .get(`/api/v1/trucks/${truckId}`)
        .set('Authorization', `Bearer ${adminA()}`)
        .expect(200),
      await request(server)
        .patch(`/api/v1/trucks/${truckId}`)
        .set('Authorization', `Bearer ${adminA()}`)
        .send({ model: 'Scania R' })
        .expect(200),
      await request(server)
        .patch(`/api/v1/trucks/${truckId}/withdraw`)
        .set('Authorization', `Bearer ${adminA()}`)
        .expect(200),
      await request(server)
        .patch(`/api/v1/trucks/${truckId}/restore`)
        .set('Authorization', `Bearer ${adminA()}`)
        .expect(200),
      await request(server)
        .patch(`/api/v1/trucks/${truckId}/qr-token/revoke`)
        .set('Authorization', `Bearer ${adminA()}`)
        .expect(200),
    ];

    for (const res of reads) {
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('CARD-T056-SECRET');
      expect(body).not.toContain('nfcCardUid');
      expect(body).not.toContain('qrToken');
    }
  });

  it('the minted token is returned once and is never readable back afterwards (FR-042)', async () => {
    const created = await request(server)
      .post('/api/v1/trucks')
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ plateNumber: 'FLEET-T056-B' })
      .expect(201);
    const minted = await request(server)
      .post(`/api/v1/trucks/${created.body.id}/qr-token`)
      .set('Authorization', `Bearer ${adminA()}`)
      .expect(201);
    const token: string = minted.body.qrToken;
    expect(token).toBeTruthy();

    // The mint response is the single legitimate sighting. Afterwards the
    // truck reports only THAT it has a code, never which one — so a leaked
    // admin session cannot enumerate live codes from the fleet list.
    const detail = await request(server)
      .get(`/api/v1/trucks/${created.body.id}`)
      .set('Authorization', `Bearer ${adminA()}`)
      .expect(200);
    expect(detail.body.hasCode).toBe(true);
    expect(JSON.stringify(detail.body)).not.toContain(token);

    // Rotation issues a genuinely different token rather than re-showing one.
    const rotated = await request(server)
      .post(`/api/v1/trucks/${created.body.id}/qr-token/rotate`)
      .set('Authorization', `Bearer ${adminA()}`)
      .expect(201);
    expect(rotated.body.qrToken).not.toBe(token);
  });

  // --- T057 -----------------------------------------------------------

  it('a tank has no credential at all — not in the schema, not on any endpoint (FR-048c)', async () => {
    // The schema is the primary assertion: a tank is assigned, never
    // verified, so there must be nowhere to put a credential in the first
    // place. Everything below only guards the door to a room that is empty.
    const tankModel = app.get<Model<TankDocument>>(getModelToken(Tank.name));
    const paths = Object.keys(tankModel.schema.paths);
    expect(paths).not.toContain('nfcCardUid');
    expect(paths).not.toContain('qrToken');

    // `forbidNonWhitelisted` turns an attempt to set one into a 400 rather
    // than a silent strip, so this cannot regress into quiet acceptance.
    await request(server)
      .post('/api/v1/tanks')
      .set('Authorization', `Bearer ${adminA()}`)
      .send({
        code: 'FLEET-T057',
        material: 'IRON',
        maxCapacityLiters: 25_000,
        fuelTypes: ['DIESEL'],
        nfcCardUid: 'CARD-ON-A-TANK',
      })
      .expect(400);

    const created = await request(server)
      .post('/api/v1/tanks')
      .set('Authorization', `Bearer ${adminA()}`)
      .send({
        code: 'FLEET-T057-OK',
        material: 'IRON',
        maxCapacityLiters: 25_000,
        fuelTypes: ['DIESEL'],
      })
      .expect(201);
    const tankId = created.body._id;

    // No pairing or minting route exists for a tank — the truck's own verbs
    // must 404 here rather than quietly doing something.
    await request(server)
      .post(`/api/v1/tanks/${tankId}/pair-card`)
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ nfcCardUid: 'CARD-ON-A-TANK' })
      .expect(404);
    await request(server)
      .post(`/api/v1/tanks/${tankId}/qr-token`)
      .set('Authorization', `Bearer ${adminA()}`)
      .expect(404);

    for (const res of [
      await request(server)
        .get('/api/v1/tanks')
        .set('Authorization', `Bearer ${adminA()}`)
        .expect(200),
      await request(server)
        .get(`/api/v1/tanks/${tankId}`)
        .set('Authorization', `Bearer ${adminA()}`)
        .expect(200),
    ]) {
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('nfcCardUid');
      expect(body).not.toContain('qrToken');
    }
  });

  it('material is recorded fact and never derives the permitted grades (FR-048g)', async () => {
    // An iron tank and an aluminium tank are equally free to carry any
    // grade the operator states. Deriving grades from material would be a
    // plausible-looking inference the spec explicitly forbids.
    const iron = await request(server)
      .post('/api/v1/tanks')
      .set('Authorization', `Bearer ${adminA()}`)
      .send({
        code: 'FLEET-MATERIAL-IRON',
        material: 'IRON',
        maxCapacityLiters: 10_000,
        fuelTypes: ['PETROL_95', 'KEROSENE'],
      })
      .expect(201);
    expect(iron.body.fuelTypes).toEqual(['PETROL_95', 'KEROSENE']);

    // Changing the material leaves the grades exactly as stated.
    const updated = await request(server)
      .patch(`/api/v1/tanks/${iron.body._id}`)
      .set('Authorization', `Bearer ${adminA()}`)
      .send({ material: 'ALUMINIUM' })
      .expect(200);
    expect(updated.body.material).toBe('ALUMINIUM');
    expect(updated.body.fuelTypes).toEqual(['PETROL_95', 'KEROSENE']);
  });
});
