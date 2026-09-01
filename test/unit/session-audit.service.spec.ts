import {
  SessionAuditService,
  SessionSubject,
} from '../../src/modules/sessions/session-audit.service';
import { SessionEventType } from '../../src/common/enums/session-event-type.enum';
import { SessionRevocationCause } from '../../src/common/enums/session-revocation-cause.enum';
import { UserRole } from '../../src/common/enums/user-role.enum';

function fakeSessionEventModel() {
  const created: Record<string, unknown>[] = [];
  return {
    created,
    create: jest.fn(async (docs: Record<string, unknown>[]) => {
      created.push(...docs);
      return docs;
    }),
  };
}

const SUBJECT: SessionSubject = {
  userId: 'driver-1',
  companyId: 'company-1',
  role: UserRole.DRIVER,
  generation: 3,
};

describe('SessionAuditService (spec 006 FR-043–046)', () => {
  let model: ReturnType<typeof fakeSessionEventModel>;
  let service: SessionAuditService;

  beforeEach(() => {
    model = fakeSessionEventModel();
    service = new SessionAuditService(model as never);
  });

  it('writes one row per lifecycle event with the type set correctly', async () => {
    await service.signedIn(SUBJECT);
    await service.signedOut(SUBJECT);
    await service.revoked(SUBJECT, SessionRevocationCause.ACCOUNT_DEACTIVATED);
    await service.recoveryRequested(SUBJECT);
    await service.recoveryVerifyFailed(SUBJECT);

    expect(model.created).toHaveLength(5);
    expect(model.created.map((r) => r.type)).toEqual([
      SessionEventType.SIGNED_IN,
      SessionEventType.SIGNED_OUT,
      SessionEventType.REVOKED,
      SessionEventType.RECOVERY_REQUESTED,
      SessionEventType.RECOVERY_VERIFY_FAILED,
    ]);
  });

  it('carries `cause` only on a revoked row, never on the others', async () => {
    await service.signedIn(SUBJECT);
    await service.revoked(SUBJECT, SessionRevocationCause.SIGNED_IN_ELSEWHERE);

    expect(model.created[0].cause).toBeUndefined();
    expect(model.created[1].cause).toBe(SessionRevocationCause.SIGNED_IN_ELSEWHERE);
  });

  it('records the generation the caller supplies, unmodified', async () => {
    await service.signedOut({ ...SUBJECT, generation: 7 });
    expect(model.created[0].generation).toBe(7);
  });

  it('passes the companyId through as given, including absent (SUPER_ADMIN has none)', async () => {
    await service.signedIn({ ...SUBJECT, companyId: undefined, role: UserRole.SUPER_ADMIN });
    expect(model.created[0].companyId).toBeUndefined();
  });

  it('never writes a token, code, or password — only the fields SessionSubject carries (FR-045)', async () => {
    await service.signedIn(SUBJECT);
    await service.revoked(SUBJECT, SessionRevocationCause.PASSWORD_RESET);

    const serialized = JSON.stringify(model.created);
    // The row can only ever contain what SessionSubject + the fixed shape
    // allow — there is no field this service could plausibly leak a secret
    // through, but this pins that down concretely rather than by
    // inspection: none of the keys resemble anything secret-shaped.
    for (const row of model.created) {
      expect(Object.keys(row).sort()).toEqual(
        ['cause', 'companyId', 'generation', 'occurredAt', 'role', 'type', 'userId'].sort(),
      );
    }
    // `PASSWORD_RESET` is a legitimate cause *label*, not a secret value —
    // so the check that actually matters is the exact key set above; this
    // is a narrower belt-and-braces pass over the *values*, not the
    // enum-name substrings that key set already pins down.
    const values = model.created
      .flatMap((r) => Object.entries(r))
      .filter(([key]) => key !== 'occurredAt') // a Date, not a candidate secret
      .map(([, v]) => String(v));
    for (const value of values) {
      expect(value).not.toMatch(/^\d{6}$/); // a plaintext OTP shape
      expect(value.length).toBeLessThan(64); // no hash/salt/token-length value
    }
  });

  it('forwards the ClientSession to Model.create for transactional writes', async () => {
    const fakeSession = { id: 'txn-1' } as never;
    await service.signedOut(SUBJECT, fakeSession);
    expect(model.create).toHaveBeenCalledWith(expect.any(Array), { session: fakeSession });
  });
});
