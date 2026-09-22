import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Connection, Types } from 'mongoose';
import { getConnectionToken } from '@nestjs/mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedTwoCompanies, TwoCompanyFixture } from '../utils/fixtures';
import { AnnouncementFanoutProcessor } from '../../src/modules/announcements/queues/announcement-fanout.processor';
import { AnnouncementState } from '../../src/common/enums/announcement-state.enum';
import { AnnouncementDeliveryFailureReason } from '../../src/common/enums/announcement-delivery-failure-reason.enum';
import { NotificationType } from '../../src/common/enums/notification-type.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { CompanyStatus } from '../../src/common/enums/company-status.enum';

jest.setTimeout(180_000);

/**
 * spec 017 (operator dashboard) US6 / FR-048–FR-056 / SC-008, SC-009.
 *
 * **The guard that matters here is T094.** The fan-out runs in a BullMQ worker
 * with no request context, so both scoping plugins take their bypass and
 * `pre('save')` stamps nothing. A notification written with the wrong
 * `companyId` is INVISIBLE to the administrator it was addressed to — while the
 * operator, who bypasses scoping, sees it and counts the delivery a success.
 * Reading the delivery back as the operator therefore proves nothing at all
 * (research R9), so every delivery assertion below authenticates as the
 * RECIPIENT.
 */
describe('Platform announcements reach every company administrator (US6)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let connection: Connection;
  let processor: AnnouncementFanoutProcessor;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    connection = app.get<Connection>(getConnectionToken());
    processor = app.get(AnnouncementFanoutProcessor);
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  const send = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/v1/announcements')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  /**
   * Runs the fan-out job synchronously.
   *
   * The route deliberately does NOT wait for delivery (FR-055), so a test that
   * asserted on delivery right after the 202 would be asserting on a race. This
   * drives the processor directly with the same job shape the queue enqueues,
   * which also makes the idempotency test able to run it TWICE on purpose.
   */
  async function runFanOut(announcementId: string) {
    await processor.process({ data: { announcementId } } as never);
  }

  /** The recipient's OWN notification list — the only trustworthy read. */
  const notificationsOf = (token: string) =>
    request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${token}`);

  async function announcementsFor(token: string, announcementId: string) {
    const res = await notificationsOf(token).expect(200);
    return res.body.items.filter(
      (n: { type: string; payload?: { announcementId?: string } }) =>
        n.type === NotificationType.PLATFORM_ANNOUNCEMENT &&
        n.payload?.announcementId === announcementId,
    );
  }

  describe('the route accepts and enqueues rather than delivering (FR-055)', () => {
    it('returns 202 promptly with the intended count and a QUEUED state', async () => {
      const res = await send(fixtures.superAdmin.token, {
        title: 'Scheduled maintenance',
        body: 'The platform will be briefly unavailable on Friday.',
      }).expect(202);

      expect(res.body.announcementId).toBeTruthy();
      expect(res.body.state).toBe(AnnouncementState.QUEUED);
      // Four administrators across two fixture companies: two fuel, two
      // transport.
      expect(res.body.intendedRecipientCount).toBeGreaterThanOrEqual(4);
    });

    it('does not block on delivery — nothing is delivered before the job runs', async () => {
      const res = await send(fixtures.superAdmin.token, {
        title: 'Not yet fanned out',
        body: 'This one has not been processed.',
      }).expect(202);

      const delivered = await connection
        .collection('announcementdeliveries')
        .countDocuments({ announcementId: new Types.ObjectId(res.body.announcementId) });
      expect(delivered).toBe(0);
    });
  });

  /**
   * T094 — **guard test (trap 3).** Asserted as the RECIPIENT.
   */
  describe('GUARD: delivery is verified as the RECIPIENT, never as the operator (research R9)', () => {
    let announcementId: string;

    beforeAll(async () => {
      const res = await send(fixtures.superAdmin.token, {
        title: 'Addressed to administrators',
        body: 'Every company administrator should be able to read this.',
      }).expect(202);
      announcementId = res.body.announcementId;
      await runFanOut(announcementId);
    });

    it('the fuel company administrator can read it in their OWN notification list', async () => {
      // A notification stamped with the wrong companyId is invisible here and
      // perfectly visible to the operator. This is the assertion that catches
      // it; reading it back as the operator would pass either way.
      const mine = await announcementsFor(fixtures.companyA.admin.token, announcementId);
      expect(mine).toHaveLength(1);
      expect(mine[0].payload.title).toBe('Addressed to administrators');
    });

    it('the transport company administrator can read it too', async () => {
      const mine = await announcementsFor(fixtures.companyA.transportAdmin.token, announcementId);
      expect(mine).toHaveLength(1);
    });

    it('every stored notification carries its RECIPIENT`s companyId, not the sender`s', async () => {
      const notifications = await connection
        .collection('notifications')
        .find({ type: NotificationType.PLATFORM_ANNOUNCEMENT })
        .toArray();
      expect(notifications.length).toBeGreaterThan(0);

      for (const notification of notifications) {
        const recipient = await connection
          .collection('users')
          .findOne({ _id: notification.recipientUserId });
        expect(String(notification.companyId)).toBe(String(recipient!.companyId));
      }
    });
  });

  describe('recipients are administrators, asserted BY ROLE (FR-049, FR-051, SC-008)', () => {
    let announcementId: string;

    beforeAll(async () => {
      const res = await send(fixtures.superAdmin.token, {
        title: 'Role scoping',
        body: 'Administrators only.',
      }).expect(202);
      announcementId = res.body.announcementId;
      await runFanOut(announcementId);
    });

    it('every recipient holds an administrator role — no CLIENT and no DRIVER', async () => {
      const deliveries = await connection
        .collection('announcementdeliveries')
        .find({
          announcementId: new Types.ObjectId(announcementId),
          // Company-addressed `NO_ACTIVE_ADMIN` rows carry no `recipientUserId`
          // at all, so they are excluded here exactly as the index excludes them.
          recipientUserId: { $exists: true },
        })
        .toArray();
      expect(deliveries.length).toBeGreaterThan(0);

      for (const delivery of deliveries) {
        const recipient = await connection
          .collection('users')
          .findOne({ _id: delivery.recipientUserId });
        // By ROLE, never by count: a count assertion passes just as happily
        // when the right number of the wrong people received it.
        expect([UserRole.FUEL_COMPANY_ADMIN, UserRole.TRANSPORT_COMPANY_ADMIN]).toContain(
          recipient!.role,
        );
      }
    });

    it('a CLIENT receives nothing', async () => {
      const theirs = await announcementsFor(fixtures.companyA.client.token, announcementId);
      expect(theirs).toHaveLength(0);
    });

    it('a DRIVER receives nothing', async () => {
      const theirs = await announcementsFor(fixtures.companyA.driver.token, announcementId);
      expect(theirs).toHaveLength(0);
    });
  });

  describe('a targeted announcement reaches only those companies (FR-050)', () => {
    it('company B`s administrator receives nothing when only company A is named', async () => {
      const res = await send(fixtures.superAdmin.token, {
        title: 'Company A only',
        body: 'This concerns one company.',
        targetCompanyIds: [fixtures.companyA.companyId],
      }).expect(202);
      await runFanOut(res.body.announcementId);

      const forA = await announcementsFor(fixtures.companyA.admin.token, res.body.announcementId);
      const forB = await announcementsFor(fixtures.companyB.admin.token, res.body.announcementId);
      expect(forA).toHaveLength(1);
      expect(forB).toHaveLength(0);
    });
  });

  /** T097 — FR-053/SC-009. */
  describe('re-running the fan-out produces ZERO duplicates (FR-053, SC-009)', () => {
    it('each administrator still holds exactly one', async () => {
      const res = await send(fixtures.superAdmin.token, {
        title: 'Idempotency',
        body: 'BullMQ is at-least-once; this job will run twice.',
      }).expect(202);
      const announcementId = res.body.announcementId;

      await runFanOut(announcementId);
      const afterFirst = await announcementsFor(fixtures.companyA.admin.token, announcementId);
      expect(afterFirst).toHaveLength(1);

      // A redelivered job. The unique index refuses the duplicate insert and
      // the processor skips — nothing here depends on a prior read.
      await runFanOut(announcementId);
      const afterSecond = await announcementsFor(fixtures.companyA.admin.token, announcementId);
      expect(afterSecond).toHaveLength(1);

      const deliveries = await connection
        .collection('announcementdeliveries')
        .countDocuments({ announcementId: new Types.ObjectId(announcementId) });
      const notifications = await connection.collection('notifications').countDocuments({
        type: NotificationType.PLATFORM_ANNOUNCEMENT,
        'payload.announcementId': announcementId,
      });
      expect(notifications).toBe(deliveries - (await failureCount(announcementId)));
    });
  });

  async function failureCount(announcementId: string): Promise<number> {
    return connection.collection('announcementdeliveries').countDocuments({
      announcementId: new Types.ObjectId(announcementId),
      failureReason: { $exists: true },
    });
  }

  /** T098 — FR-054. Each unreachable case gets its OWN named reason. */
  describe('unreachable recipients are recorded with a named reason (FR-054)', () => {
    let announcementId: string;
    let deactivatedAdminId: string;

    beforeAll(async () => {
      // Company B suspended; company A's fuel administrator deactivated.
      await request(app.getHttpServer())
        .patch(`/api/v1/companies/${fixtures.companyB.companyId}/status`)
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .send({ status: CompanyStatus.SUSPENDED })
        .expect(200);

      deactivatedAdminId = fixtures.companyA.admin.id;
      await connection
        .collection('users')
        .updateOne({ _id: new Types.ObjectId(deactivatedAdminId) }, { $set: { isActive: false } });

      const res = await send(fixtures.superAdmin.token, {
        title: 'Unreachable cases',
        body: 'Some of these will not land.',
      }).expect(202);
      announcementId = res.body.announcementId;
      await runFanOut(announcementId);
    });

    afterAll(async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/companies/${fixtures.companyB.companyId}/status`)
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .send({ status: CompanyStatus.ACTIVE })
        .expect(200);
      await connection
        .collection('users')
        .updateOne({ _id: new Types.ObjectId(deactivatedAdminId) }, { $set: { isActive: true } });
    });

    it('a suspended company`s administrator is recorded as COMPANY_SUSPENDED', async () => {
      const rows = await connection
        .collection('announcementdeliveries')
        .find({
          announcementId: new Types.ObjectId(announcementId),
          failureReason: AnnouncementDeliveryFailureReason.COMPANY_SUSPENDED,
        })
        .toArray();
      expect(rows.length).toBeGreaterThan(0);
      // Recorded as missed, never as delivered.
      for (const row of rows) {
        expect(row.notificationId).toBeUndefined();
      }
    });

    it('a deactivated administrator is recorded as ADMIN_DEACTIVATED — a DIFFERENT reason', async () => {
      const row = await connection.collection('announcementdeliveries').findOne({
        announcementId: new Types.ObjectId(announcementId),
        recipientUserId: new Types.ObjectId(deactivatedAdminId),
      });
      expect(row).not.toBeNull();
      expect(row!.failureReason).toBe(AnnouncementDeliveryFailureReason.ADMIN_DEACTIVATED);
      expect(row!.notificationId).toBeUndefined();
      // Two different unreachable causes, two different reasons. A boolean
      // `delivered: false` would collapse them into one shrug.
      expect(row!.failureReason).not.toBe(AnnouncementDeliveryFailureReason.COMPANY_SUSPENDED);
    });

    it('neither is counted as delivered', async () => {
      const announcement = await connection
        .collection('announcements')
        .findOne({ _id: new Types.ObjectId(announcementId) });
      expect(announcement!.failedCount).toBeGreaterThan(0);
      expect(announcement!.state).toBe(AnnouncementState.COMPLETED);
    });

    it('surfaces the failures on GET /announcements/:id (FR-054)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/announcements/${announcementId}`)
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .expect(200);

      expect(res.body.failures.length).toBeGreaterThan(0);
      for (const failure of res.body.failures) {
        expect(failure.failureReason).toBeTruthy();
      }
    });

    /**
     * FR-053 for the COMPANY-addressed row — the half the idempotency suite
     * above cannot reach, because it re-runs a fan-out whose every row names a
     * person.
     *
     * This is the case that went unguarded: the second unique index was
     * declared with `$exists: false`, which MongoDB refuses inside a
     * `partialFilterExpression`, and `autoIndex` swallowed the error. Every
     * user-addressed assertion still passed, so nothing failed while a
     * redelivery was free to duplicate this row.
     */
    it('a re-run does not duplicate the company-addressed NO_ACTIVE_ADMIN row (FR-053)', async () => {
      const noActiveAdminRows = () =>
        connection.collection('announcementdeliveries').countDocuments({
          announcementId: new Types.ObjectId(announcementId),
          failureReason: AnnouncementDeliveryFailureReason.NO_ACTIVE_ADMIN,
          companyAddressed: true,
        });

      const before = await noActiveAdminRows();
      expect(before).toBeGreaterThan(0);

      // The redelivered job. At-least-once is normal, not exceptional.
      await runFanOut(announcementId);

      expect(await noActiveAdminRows()).toBe(before);
    });

    /**
     * The guarantee above is an INDEX, so assert the index exists. Mongoose's
     * `autoIndex` reports a rejected index build on an event nothing listens
     * to: without this, an index the database refuses to create is
     * indistinguishable from one it created, and the application boots clean
     * either way.
     */
    it('both partial unique indexes actually exist in the database', async () => {
      const indexes = await connection.collection('announcementdeliveries').indexes();
      const unique = indexes.filter((i) => i.unique);
      const keys = unique.map((i) => JSON.stringify(i.key));

      expect(keys).toContain(JSON.stringify({ announcementId: 1, recipientUserId: 1 }));
      expect(keys).toContain(JSON.stringify({ announcementId: 1, companyId: 1 }));

      // Mutually exclusive, or a row falls under both or neither.
      for (const index of unique) {
        expect(index.partialFilterExpression).toBeDefined();
      }
    });
  });

  describe('the list and detail routes serve FR-052', () => {
    it('lists what was sent, newest first, cursor-paged', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/announcements')
        .set('Authorization', `Bearer ${fixtures.superAdmin.token}`)
        .expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body).toHaveProperty('nextCursor');
      for (const item of res.body.items) {
        expect(item).toHaveProperty('title');
        expect(item).toHaveProperty('intendedRecipientCount');
        expect(item).toHaveProperty('state');
      }
    });
  });

  describe('sending is the operator`s alone (FR-056, SC-012)', () => {
    it.each([
      ['FUEL_COMPANY_ADMIN', () => fixtures.companyA.admin.token],
      ['TRANSPORT_COMPANY_ADMIN', () => fixtures.companyA.transportAdmin.token],
      ['CLIENT', () => fixtures.companyA.client.token],
      ['DRIVER', () => fixtures.companyA.driver.token],
    ])('refuses a %s with 403', async (_role, token) => {
      await send(token(), { title: 'Nope', body: 'Not mine to send.' }).expect(403);
    });

    it('refuses every non-operator role on the list and detail routes too', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/announcements')
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(403);
    });
  });

  describe('the notification routes stay role-agnostic (FR-046, FR-047, FR-075)', () => {
    it('the operator can read, mark one read, and mark all read', async () => {
      const res = await send(fixtures.superAdmin.token, {
        title: 'For the read flow',
        body: 'Marks.',
      }).expect(202);
      await runFanOut(res.body.announcementId);

      const list = await notificationsOf(fixtures.companyA.admin.token).expect(200);
      const first = list.body.items[0];
      await request(app.getHttpServer())
        .patch(`/api/v1/notifications/${first._id}/read`)
        .set('Authorization', `Bearer ${fixtures.companyA.admin.token}`)
        .expect(200);

      const after = await notificationsOf(fixtures.companyA.admin.token).expect(200);
      const marked = after.body.items.find(
        (n: { _id: string }) => String(n._id) === String(first._id),
      );
      expect(marked.readAt).toBeTruthy();
    });
  });
});
