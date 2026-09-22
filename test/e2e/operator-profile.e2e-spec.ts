import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Connection, Types } from 'mongoose';
import { getConnectionToken } from '@nestjs/mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import {
  seedTwoCompanies,
  TwoCompanyFixture,
  DEFAULT_PASSWORD,
  uniquePhone,
  superAdminActor,
} from '../utils/fixtures';
import { UsersService } from '../../src/modules/users/users.service';
import { SMS_SENDER, SmsSender } from '../../src/common/sms/sms-sender.port';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { ErrorCode } from '../../src/common/enums/error-code.enum';

jest.setTimeout(180_000);

/**
 * spec 017 (operator dashboard) US7 / FR-057–FR-063 / SC-010.
 *
 * Most of this story already worked (research R10). The one real defect is the
 * duplicate-phone pre-check: it called `findByPhoneForAuth`, which is scoped to
 * `CLIENT`/`DRIVER` **on purpose**, so an administrator changing onto another
 * administrator's number passed the check, **spent an SMS**, and was refused
 * only at confirm by the unique index feature 015 extended to all five roles —
 * breaking `PhoneVerificationService`'s own documented promise that "a message
 * is never spent on a doomed change". T116 is that test.
 */
describe('The operator`s own account and sign-in number (US7)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: TwoCompanyFixture;
  let connection: Connection;
  let sentMessages: { to: string }[];

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedTwoCompanies(app);
    connection = app.get<Connection>(getConnectionToken());

    // Counts SMS sends so "no message was spent" is a real assertion rather
    // than an inference from the status code.
    const sender = app.get<SmsSender>(SMS_SENDER);
    sentMessages = [];
    jest.spyOn(sender, 'send').mockImplementation(async (to: string) => {
      sentMessages.push({ to });
    });
  }, 240_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  const account = (token: string) =>
    request(app.getHttpServer())
      .get('/api/v1/auth/me/account')
      .set('Authorization', `Bearer ${token}`);

  const requestPhoneChange = (token: string, newPhone: string) =>
    request(app.getHttpServer())
      .post('/api/v1/users/me/phone/verification')
      .set('Authorization', `Bearer ${token}`)
      .send({ newPhone });

  describe('the operator reads their real identity (FR-057, scenario 1)', () => {
    it('returns name, email and the real sign-in number — not a mask', async () => {
      const res = await account(fixtures.superAdmin.token).expect(200);
      expect(res.body.email).toBe(fixtures.superAdmin.email);
      expect(res.body.phone).toBe(fixtures.superAdmin.phone);
      expect(typeof res.body.fullName).toBe('string');
      // A masked number is worse than useless on this screen: an operator
      // checking which number they sign in with cannot read it off a mask.
      expect(res.body.phone).not.toMatch(/\*/);
    });

    it('carries no permission list and no account statistic (FR-063)', async () => {
      const res = await account(fixtures.superAdmin.token).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(
        ['activeSessionCount', 'email', 'fullName', 'lastSignInAt', 'phone'].sort(),
      );
      expect(res.body).not.toHaveProperty('permissions');
      expect(res.body).not.toHaveProperty('roles');
    });
  });

  /**
   * Its OWN operator account, deliberately.
   *
   * Feature 015 caps an administrator at `auth.maxAdminSessions` concurrent
   * sessions and EVICTS the oldest beyond it. Signing the shared fixture
   * operator in repeatedly here would evict the very token every other test in
   * this file authenticates with — every one of them failing with a 401 that
   * says nothing about what it was testing. The session-churn cases get an
   * account nobody else holds a token for.
   */
  describe('sessions and last sign-in (FR-058, FR-059, SC-010)', () => {
    let churnEmail: string;
    let firstToken: string;

    beforeAll(async () => {
      const operator = await superAdminActor(app, 'operator-sessions@platform.test');
      churnEmail = operator.email;
      firstToken = operator.token;
    });

    const signIn = async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: churnEmail, password: DEFAULT_PASSWORD })
        .expect(201);
      return res.body.accessToken as string;
    };

    it('reports the number of devices currently holding a session', async () => {
      // A second sign-in from another device — feature 015's concurrent
      // administrator sessions.
      const second = await signIn();
      const res = await account(second).expect(200);
      expect(res.body.activeSessionCount).toBeGreaterThanOrEqual(2);
    });

    it('reports a lastSignInAt matching the most recent sign-in', async () => {
      const before = new Date();
      const latest = await signIn();

      const res = await account(latest).expect(200);
      expect(res.body.lastSignInAt).toBeTruthy();
      expect(new Date(res.body.lastSignInAt).getTime()).toBeGreaterThanOrEqual(
        before.getTime() - 2_000,
      );
    });

    it('survives a sign-out — the audit log, not the session array, answers it', async () => {
      const session = await signIn();
      const reader = await signIn();
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${session}`)
        .expect(204);

      // `activeSessions` is now one shorter, but the last sign-in is still
      // known. Read from the array it would report "never" for an operator who
      // signs in and out daily.
      const res = await account(reader).expect(200);
      expect(res.body.lastSignInAt).toBeTruthy();
      expect(firstToken).toBeTruthy();
    });
  });

  /**
   * T116 — **the FR-061 test.** The refusal must land at the REQUEST step, with
   * no SMS spent.
   */
  describe('a number held by another ADMINISTRATOR is refused before any SMS (FR-061)', () => {
    it('returns 409 at the request step and sends nothing', async () => {
      const otherAdminPhone = fixtures.companyA.admin.phone;
      const sentBefore = sentMessages.length;

      const res = await requestPhoneChange(fixtures.superAdmin.token, otherAdminPhone).expect(409);
      expect(res.body.error ?? res.body.message?.error).toBe(ErrorCode.PHONE_IN_USE);

      // The assertion the CLIENT/DRIVER-scoped lookup fails: it would have
      // found no holder, issued a code, sent it, and refused only at confirm.
      expect(sentMessages.length).toBe(sentBefore);
    });

    it('leaves the operator`s existing number unchanged', async () => {
      const res = await account(fixtures.superAdmin.token).expect(200);
      expect(res.body.phone).toBe(fixtures.superAdmin.phone);
    });

    it('still refuses a number held by a CLIENT — the pre-existing case', async () => {
      const sentBefore = sentMessages.length;
      await requestPhoneChange(fixtures.superAdmin.token, fixtures.companyA.client.phone).expect(
        409,
      );
      expect(sentMessages.length).toBe(sentBefore);
    });
  });

  /** T117 — a deactivated account still HOLDS its number. */
  describe('a number held by a DEACTIVATED account is also refused (edge case)', () => {
    let deactivatedPhone: string;

    beforeAll(async () => {
      const usersService = app.get(UsersService);
      deactivatedPhone = uniquePhone();
      const user = await usersService.create({
        companyId: fixtures.companyA.companyId as never,
        role: UserRole.FUEL_COMPANY_ADMIN,
        email: 'deactivated-holder@platform.test',
        password: DEFAULT_PASSWORD,
        fullName: 'Deactivated Holder',
        phone: deactivatedPhone,
        isActive: true,
      });
      await connection
        .collection('users')
        .updateOne({ _id: new Types.ObjectId(String(user._id)) }, { $set: { isActive: false } });
    });

    it('refuses at the request step with no SMS spent', async () => {
      const sentBefore = sentMessages.length;
      // The unique index does not exempt a deactivated account, so a change
      // onto this number would fail at confirm for exactly the same reason.
      await requestPhoneChange(fixtures.superAdmin.token, deactivatedPhone).expect(409);
      expect(sentMessages.length).toBe(sentBefore);
    });
  });

  /**
   * T118 — **the FR-062 regression test.** A future "re-authenticate after a
   * credential change" instinct would silently destroy feature 015's
   * concurrent administrator sessions.
   */
  describe('changing the number does NOT revoke any session (FR-062)', () => {
    it('leaves sessionGeneration and activeSessions untouched, other sessions still working', async () => {
      // Its own operator again — this case signs in a second device, and doing
      // that on the shared fixture would push it toward the session cap.
      const operator = await superAdminActor(app, 'operator-phone-change@platform.test');
      const other = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: operator.email, password: DEFAULT_PASSWORD })
        .expect(201);

      const before = await connection
        .collection('users')
        .findOne({ _id: new Types.ObjectId(operator.id) });

      const newPhone = uniquePhone();
      await requestPhoneChange(operator.token, newPhone).expect(202);

      const after = await connection
        .collection('users')
        .findOne({ _id: new Types.ObjectId(operator.id) });

      expect(after!.sessionGeneration).toBe(before!.sessionGeneration);
      expect((after!.activeSessions as unknown[]).length).toBe(
        (before!.activeSessions as unknown[]).length,
      );

      // And the other device is still signed in.
      await request(app.getHttpServer())
        .get('/api/v1/auth/me/account')
        .set('Authorization', `Bearer ${other.body.accessToken}`)
        .expect(200);
    });
  });

  describe('the account route is the operator`s alone (FR-074, SC-012)', () => {
    it.each([
      ['FUEL_COMPANY_ADMIN', () => fixtures.companyA.admin.token],
      ['TRANSPORT_COMPANY_ADMIN', () => fixtures.companyA.transportAdmin.token],
      ['CLIENT', () => fixtures.companyA.client.token],
      ['DRIVER', () => fixtures.companyA.driver.token],
    ])('refuses a %s with 403', async (_role, token) => {
      await account(token()).expect(403);
    });

    it('still serves GET /auth/me to every role, unchanged (FR-075)', async () => {
      for (const token of [
        fixtures.companyA.admin.token,
        fixtures.companyA.client.token,
        fixtures.companyA.driver.token,
      ]) {
        const res = await request(app.getHttpServer())
          .get('/api/v1/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        expect(res.body).toHaveProperty('id');
        expect(res.body).toHaveProperty('role');
        expect(res.body).toHaveProperty('isActive');
      }
    });
  });
});
