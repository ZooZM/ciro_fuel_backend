import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { getModelToken } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, uniquePhone, TwoCompanyFixture, settleClientReview } from '../utils/fixtures';
import { ASSIGNMENT_ESCALATION_QUEUE } from '../../src/modules/assignment-escalation/queues/assignment-escalation-queue.service';
import { OrderStatus } from '../../src/common/enums/order-status.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { TankMaterial } from '../../src/common/enums/tank-material.enum';
import { FuelType } from '../../src/common/enums/fuel-type.enum';
import {
  Notification,
  NotificationDocument,
} from '../../src/modules/notifications/schemas/notification.schema';
import { UsersService } from '../../src/modules/users/users.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { TrucksService } from '../../src/modules/trucks/trucks.service';
import { TanksService } from '../../src/modules/tanks/tanks.service';

jest.setTimeout(120_000);

/**
 * spec 010 T023/T026 (FR-009/FR-010/FR-014a/FR-017): the acknowledge
 * endpoint's ownership/idempotency contract, a regression guard on the
 * existing ORDER_ASSIGNED notification this feature edits `assignDriver`
 * right alongside, and the escalation's cancellation-on-cancellation (never
 * on a vehicle-only reassignment) correctness.
 */
describe('Assignment escalation (spec 010 US2)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let escalationQueue: Queue;
  let notificationModel: Model<NotificationDocument>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    escalationQueue = app.get(getQueueToken(ASSIGNMENT_ESCALATION_QUEUE));
    notificationModel = app.get(getModelToken(Notification.name));
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  /** Every test in this file assigns a driver, so each needs its own driver + truck + tank
   *  — reusing `fixtures.companyA.driver`/`truck`/`tank` across tests would leave the
   *  second test's assignment attempt failing on an already-committed driver/vehicle
   *  (409), masking whatever the test actually means to check. */
  async function freshDriverAndVehicle(): Promise<{
    driverId: string;
    driverToken: string;
    truckId: string;
    tankId: string;
  }> {
    const usersService = app.get(UsersService);
    const authService = app.get(AuthService);
    const trucksService = app.get(TrucksService);
    const tanksService = app.get(TanksService);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const { transportCompanyId } = fixtures.companyA;

    const driver = await usersService.create({
      companyId: transportCompanyId as never,
      role: UserRole.DRIVER,
      email: `escalation-driver-${suffix}@escalationtest.test`,
      password: 'Password123!',
      fullName: 'Escalation Test Driver',
      phone: uniquePhone(),
      isActive: true,
      isOnline: true,
      isAvailable: true,
      location: {
        type: 'Point',
        coordinates: fixtures.companyA.driver.location,
      } as never,
    });
    const driverAuth = await authService.login({ email: driver.email, password: 'Password123!' });
    const truck = await trucksService.create(transportCompanyId, { plateNumber: `ESC-${suffix}` });
    const tank = await tanksService.create(transportCompanyId, {
      code: `ESC-TANK-${suffix}`,
      material: TankMaterial.ALUMINIUM,
      maxCapacityLiters: 5000,
      fuelTypes: [FuelType.DIESEL],
    });

    return {
      driverId: String(driver._id),
      driverToken: driverAuth.accessToken,
      truckId: String(truck._id),
      tankId: String(tank._id),
    };
  }

  async function routeAndAssign(): Promise<{
    orderId: string;
    driverId: string;
    driverToken: string;
  }> {
    const { client, admin, transportAdmin } = fixtures.companyA;
    const server = app.getHttpServer();
    const { driverId, driverToken, truckId, tankId } = await freshDriverAndVehicle();

    const createRes = await request(server)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${client.token}`)
      .send({ fuelType: 'DIESEL', quantityLiters: 500, paymentMethod: 'DEFERRED' })
      .expect(201);
    const orderId = createRes.body._id;

    await request(server)
      .patch(`/api/v1/orders/${orderId}/approve`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({})
      .expect(200);

    await settleClientReview(app, orderId);
    await request(server)
      .post(`/api/v1/dispatch/orders/${orderId}/assign`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ driverId, truckId, tankId })
      .expect(201);

    return { orderId, driverId, driverToken };
  }

  it('schedules an escalation and sends ORDER_ASSIGNED, unchanged, on assignment (FR-009 regression guard, FR-011)', async () => {
    const { orderId, driverId } = await routeAndAssign();

    const job = await escalationQueue.getJob(orderId);
    expect(job).toBeDefined();

    // Direct model check — proves the fact this task guards (the existing
    // ORDER_ASSIGNED notification is unaffected by the escalation-
    // scheduling code added right next to it), independent of the
    // notification-list endpoint's own pagination/shape.
    const notification = await notificationModel
      .findOne({ recipientUserId: driverId, type: 'ORDER_ASSIGNED', orderId })
      .exec();
    expect(notification).not.toBeNull();
  });

  it('acknowledge-assignment sets assignmentAcknowledgedAt, is idempotent, and cancels the pending escalation (FR-010, FR-014a)', async () => {
    const { orderId, driverToken } = await routeAndAssign();
    const { admin } = fixtures.companyA;
    const server = app.getHttpServer();

    expect(await escalationQueue.getJob(orderId)).toBeDefined();

    const first = await request(server)
      .post(`/api/v1/orders/${orderId}/acknowledge-assignment`)
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(201);
    expect(first.body.assignmentAcknowledgedAt).toBeTruthy();
    expect(await escalationQueue.getJob(orderId)).toBeUndefined();

    // Idempotent: a second call is a harmless no-op, not an error, and the
    // acknowledgment timestamp does not move.
    const second = await request(server)
      .post(`/api/v1/orders/${orderId}/acknowledge-assignment`)
      .set('Authorization', `Bearer ${driverToken}`)
      .expect(201);
    expect(second.body.assignmentAcknowledgedAt).toBe(first.body.assignmentAcknowledgedAt);

    // Confirm on the order detail too (operator-scoped shape).
    const orderDetail = await request(server)
      .get(`/api/v1/orders/${orderId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect(orderDetail.body.assignmentAcknowledgedAt).toBe(first.body.assignmentAcknowledgedAt);
  });

  it('refuses acknowledge-assignment with 404 for a driver the order is not assigned to (FR-017 discipline)', async () => {
    const { orderId } = await routeAndAssign();
    const { driver } = fixtures.companyB; // a different driver entirely, different company

    await request(app.getHttpServer())
      .post(`/api/v1/orders/${orderId}/acknowledge-assignment`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(404);
  });

  it('cancels the pending escalation when the order is cancelled (FR-014a)', async () => {
    const { orderId } = await routeAndAssign();
    const { admin } = fixtures.companyA;

    expect(await escalationQueue.getJob(orderId)).toBeDefined();

    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderId}/cancel`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ reason: 'Testing escalation cancellation' })
      .expect(200);

    expect(await escalationQueue.getJob(orderId)).toBeUndefined();
  });

  it('does NOT cancel the pending escalation on a vehicle-only reassignment (FR-014a, narrowed — no driver-reassignment capability exists)', async () => {
    const { orderId } = await routeAndAssign();
    const { transportAdmin, transportCompanyId } = fixtures.companyA;

    expect(await escalationQueue.getJob(orderId)).toBeDefined();

    const trucksService = app.get(TrucksService);
    const tanksService = app.get(TanksService);
    const newTruck = await trucksService.create(transportCompanyId, {
      plateNumber: `REASSIGN-${Date.now()}`,
    });
    const newTank = await tanksService.create(transportCompanyId, {
      code: `REASSIGN-TANK-${Date.now()}`,
      material: TankMaterial.ALUMINIUM,
      maxCapacityLiters: 5000,
      fuelTypes: [FuelType.DIESEL],
    });

    const reassignRes = await request(app.getHttpServer())
      .patch(`/api/v1/orders/${orderId}/reassign-vehicle`)
      .set('Authorization', `Bearer ${transportAdmin.token}`)
      .send({ truckId: String(newTruck._id), tankId: String(newTank._id) })
      .expect(200);
    expect(reassignRes.body.status).toBe(OrderStatus.ASSIGNED_TO_DRIVER);

    expect(await escalationQueue.getJob(orderId)).toBeDefined();
  });
});
