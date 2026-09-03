import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import {
  Notification,
  NotificationDocument,
} from '../../src/modules/notifications/schemas/notification.schema';
import { NotificationType } from '../../src/common/enums/notification-type.enum';

jest.setTimeout(120_000);

/**
 * feature 013 T039 (FR-025, FR-026, contracts/rest-api-delta.md §2):
 * `PATCH /notifications/read-all` marks only the caller's unread
 * notifications, returns the count, is idempotent, and cannot be aimed at
 * another user.
 */
describe('PATCH /notifications/read-all (feature 013 US3)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let notificationsService: NotificationsService;
  let notificationModel: Model<NotificationDocument>;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    notificationsService = app.get(NotificationsService);
    notificationModel = app.get(getModelToken(Notification.name));
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  beforeEach(async () => {
    await notificationModel.deleteMany({
      recipientUserId: {
        $in: [fixtures.companyA.driver.id, fixtures.companyB.driver.id],
      },
    });
  });

  async function seedUnread(userId: string, companyId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await notificationsService.notify({
        companyId,
        recipientUserId: userId,
        type: NotificationType.ORDER_ASSIGNED,
      });
    }
  }

  it("marks only the caller's unread, returns the count, and is idempotent on a second call", async () => {
    const { driver, companyId } = fixtures.companyA;
    const server = app.getHttpServer();
    await seedUnread(driver.id, companyId, 4);

    // Sanity: the driver can actually see their own notifications first —
    // they are addressed with the order's fuel-company id, a different
    // tenant from the driver's own transport company.
    const listBefore = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    expect(listBefore.body.unreadCount).toBe(4);

    const first = await request(server)
      .patch('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    expect(first.body.updated).toBe(4);

    const list = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    expect(list.body.unreadCount).toBe(0);

    const second = await request(server)
      .patch('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    expect(second.body.updated).toBe(0);
  });

  it('cannot be aimed at another user — the recipient is the token, not the request', async () => {
    const { driver: driverA, companyId } = fixtures.companyA;
    const { driver: driverB } = fixtures.companyB;
    const server = app.getHttpServer();

    await seedUnread(driverB.id, fixtures.companyB.companyId, 3);
    await seedUnread(driverA.id, companyId, 2);

    // Any body/query a caller might supply is ignored.
    const res = await request(server)
      .patch('/api/v1/notifications/read-all')
      .query({ recipientUserId: driverB.id, userId: driverB.id })
      .send({ recipientUserId: driverB.id })
      .set('Authorization', `Bearer ${driverA.token}`)
      .expect(200);
    expect(res.body.updated).toBe(2); // driver A's own, never driver B's

    const bStillUnread = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${driverB.token}`)
      .expect(200);
    expect(bStillUnread.body.unreadCount).toBe(3);
  });
});
