import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import {
  AccountMovement,
  AccountMovementDocument,
} from '../../src/modules/platform-account/schemas/account-movement.schema';

jest.setTimeout(120_000);

/**
 * spec 013 (fuel company admin dashboard) T166/T167/T168 — a company's manual,
 * evidence-carrying settlement of its ledger: recording a payment never moves the
 * balance by itself (FR-068), only the operator's confirmation does, and by exactly the
 * amount confirmed (FR-072); the supporting document is retrievable only by the paying
 * company and the operator (FR-070); and the ledger pages without duplicating or
 * skipping movements (FR-071).
 */
describe('Platform account payments (US10, FR-065/067/068/069/070/071/072)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let movementModel: Model<AccountMovementDocument>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    movementModel = app.get(getModelToken(AccountMovement.name));
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  async function accrueCommission(
    fixture: TwoCompanyFixture['companyA'],
    quantityLiters: number,
  ): Promise<void> {
    const server = app.getHttpServer();
    await request(server)
      .put(`/api/v1/users/${fixture.client.id}/credit-limit`)
      .set('Authorization', `Bearer ${fixture.admin.token}`)
      .send({ creditLimit: 1_000_000 })
      .expect(200);
    const created = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${fixture.client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters, paymentMethod: 'CREDIT' })
      .expect(201);
    await request(server)
      .patch(`/api/v1/orders/${created.body._id}/approve`)
      .set('Authorization', `Bearer ${fixture.admin.token}`)
      .send({})
      .expect(200);
  }

  it('rejects a payment with neither a reference nor a document (FR-067)', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post('/api/v1/platform-account/payments')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ amount: 10, method: 'BANK_TRANSFER' })
      .expect(400)
      .expect((res) => expect(res.body.error).toBe('PAYMENT_EVIDENCE_REQUIRED'));
  });

  it('a partial payment reduces the balance by exactly the confirmed amount; unconfirmed reduces it by nothing (T166, FR-072)', async () => {
    const server = app.getHttpServer();
    const { admin, companyId } = fixtures.companyA;

    await request(server)
      .put(`/api/v1/companies/${companyId}/commission-ceiling`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ commissionCeiling: 10_000 })
      .expect(200);
    await request(server)
      .put('/api/v1/billing/commission-terms')
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .send({ basis: 'PERCENTAGE', rate: 100 })
      .expect(200);

    // 2.5/L * 40L = 100.00 -> 100% commission = 100.00
    await accrueCommission(fixtures.companyA, 40);

    const before = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const owedBefore = before.body.commissionAccrued as number;

    const recorded = await request(server)
      .post('/api/v1/platform-account/payments')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ amount: 40, method: 'BANK_TRANSFER', reference: 'partial-payment-1' })
      .expect(201);
    expect(recorded.body.state).toBe('RECORDED');

    // Unconfirmed — the balance has not moved at all (FR-068).
    const stillOwed = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(stillOwed.body.commissionAccrued).toBeCloseTo(owedBefore, 2);

    // A FUEL_COMPANY_ADMIN cannot confirm its own payment (SA only, FR-069).
    await request(server)
      .patch(`/api/v1/platform-account/payments/${recorded.body._id}/confirm`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(403);

    await request(server)
      .patch(`/api/v1/platform-account/payments/${recorded.body._id}/confirm`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(200);

    const afterConfirm = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(afterConfirm.body.commissionAccrued).toBeCloseTo(owedBefore - 40, 2);

    // A second confirmation is refused, never a second balance movement (FR-067a).
    await request(server)
      .patch(`/api/v1/platform-account/payments/${recorded.body._id}/confirm`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(409)
      .expect((res) => expect(res.body.error).toBe('PAYMENT_ALREADY_CONFIRMED'));

    const afterSecondAttempt = await request(server)
      .get('/api/v1/billing/balances/me')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(afterSecondAttempt.body.commissionAccrued).toBeCloseTo(owedBefore - 40, 2);
  });

  it("a second fuel company cannot retrieve another company's payment document; the operator can (T167, FR-070)", async () => {
    const server = app.getHttpServer();

    const upload = await request(server)
      .post('/api/v1/files')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .field('purpose', 'PAYMENT_EVIDENCE')
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
        filename: 'evidence.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    const documentFileId = upload.body._id as string;

    await request(server)
      .post('/api/v1/platform-account/payments')
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .send({ amount: 5, method: 'BANK_TRANSFER', documentFileId })
      .expect(201);

    // The paying company itself can retrieve it.
    await request(server)
      .get(`/api/v1/files/${documentFileId}`)
      .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
      .expect(302);

    // The operator can too (SUPER_ADMIN bypasses tenant scope, same as every other
    // tenant-scoped collection).
    await request(server)
      .get(`/api/v1/files/${documentFileId}`)
      .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
      .expect(302);

    // A second fuel company gets a 404 (tenant scoping resolves a cross-tenant id to
    // nothing, never a 403 — same convention as `file-access.e2e-spec.ts`).
    await request(server)
      .get(`/api/v1/files/${documentFileId}`)
      .set('Authorization', `Bearer ${fixtures.companyB.admin.token}`)
      .expect(404);
  });

  it('pages through 25 movements with no repeats and no skips (T168, FR-071)', async () => {
    const { companyId, admin } = fixtures.companyB;
    const server = app.getHttpServer();

    const expectedIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      const movement = await movementModel.create({
        companyId: new Types.ObjectId(companyId),
        kind: 'PAYMENT_RECORDED',
        amount: 1,
        currency: 'SAR',
        state: 'RECORDED',
        reference: `pagination-${i}`,
      });
      await movementModel
        .updateOne(
          { _id: movement._id },
          { $set: { createdAt: new Date(2026, 0, 1, 10, i, 0, 0) } },
        )
        .exec();
      expectedIds.push(String(movement._id));
    }
    expectedIds.reverse(); // newest first, matching the endpoint's own sort

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await request(server)
        .get('/api/v1/platform-account/movements')
        .query(cursor ? { cursor } : {})
        .set('Authorization', `Bearer ${admin.token}`)
        .expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      seen.push(...res.body.items.map((m: { _id: string }) => m._id));
      cursor = res.body.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);

    const seededOnly = seen.filter((id) => expectedIds.includes(id));
    expect(new Set(seededOnly).size).toBe(seededOnly.length);
    expect(seededOnly).toHaveLength(expectedIds.length);
  });
});
