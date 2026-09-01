import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { NotificationType } from '../../src/common/enums/notification-type.enum';

jest.setTimeout(120_000);

/** Spec 005 T086/FR-031: `unreadCount` is a live count over the caller's
 * whole set, never scoped to whatever page happens to be on screen, and
 * never a stored counter that could drift from the notifications
 * themselves. */
describe('GET /notifications — pagination and unreadCount (spec 005 US6)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let notificationsService: NotificationsService;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    notificationsService = app.get(NotificationsService);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  it('unreadCount reflects the whole set, not the current page, and drops on mark-read', async () => {
    const { client, companyId } = fixtures.companyA;
    const server = app.getHttpServer();

    // More than one page (DEFAULT_PAGE_SIZE = 20) so the count can't be
    // satisfied by just tallying what's on screen.
    const count = 25;
    for (let i = 0; i < count; i++) {
      await notificationsService.notify({
        companyId,
        recipientUserId: client.id,
        type: NotificationType.ORDER_STATUS_CHANGED,
      });
    }

    const firstPage = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    expect(firstPage.body.items.length).toBeLessThanOrEqual(20);
    expect(firstPage.body.items.length).toBeLessThan(count);
    expect(firstPage.body.unreadCount).toBe(count);

    const notificationId = firstPage.body.items[0]._id;
    await request(server)
      .patch(`/api/v1/notifications/${notificationId}/read`)
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);

    const afterRead = await request(server)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${client.token}`)
      .expect(200);
    expect(afterRead.body.unreadCount).toBe(count - 1);
    // The item itself is still on the list — reading one doesn't delete
    // it — only the count moves.
    expect(afterRead.body.items.length).toBe(firstPage.body.items.length);
  });
});
