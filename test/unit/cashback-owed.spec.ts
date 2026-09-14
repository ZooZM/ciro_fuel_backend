import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { PlatformAccountService } from '../../src/modules/platform-account/platform-account.service';
import { AccountMovement } from '../../src/modules/platform-account/schemas/account-movement.schema';
import { AccountMovementKind } from '../../src/common/enums/account-movement-kind.enum';
import { AccountMovementState } from '../../src/common/enums/account-movement-state.enum';
import {
  AccountMovementDirection,
  directionForKind,
} from '../../src/common/enums/account-movement-direction.enum';

/**
 * spec 017 (operator dashboard) T129/FR-065/FR-067 — the owed figure NETS two
 * kinds.
 *
 * `getConfirmedBalance` is per-kind, and that is the trap research R11 exists
 * to flag: a payout recorded under `CASHBACK_PAID_OUT` leaves
 * `getConfirmedBalance(CASHBACK_CREDITED)` unchanged while still returning a
 * perfectly plausible number.
 */
describe('getCashbackOwed nets payouts against credits (FR-067)', () => {
  const companyId = new Types.ObjectId();

  /** Rows the fake model returns, keyed by the `kind` the query asked for. */
  let rowsByKind: Partial<Record<AccountMovementKind, { amount: number; reversalOfId?: unknown }[]>>;
  let service: PlatformAccountService;

  beforeEach(async () => {
    rowsByKind = {};
    const model = {
      find: jest.fn((query: { kind: AccountMovementKind; state: AccountMovementState }) => ({
        select: () => ({
          exec: async () => rowsByKind[query.kind] ?? [],
          session: () => ({ exec: async () => rowsByKind[query.kind] ?? [] }),
        }),
      })),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PlatformAccountService,
        { provide: getModelToken(AccountMovement.name), useValue: model },
      ],
    }).compile();
    service = moduleRef.get(PlatformAccountService);
  });

  it('returns the credited total when nothing has been paid out', async () => {
    rowsByKind[AccountMovementKind.CASHBACK_CREDITED] = [{ amount: 1000 }, { amount: 250 }];
    await expect(service.getCashbackOwed(companyId)).resolves.toBe(1250);
  });

  it('subtracts confirmed payouts from confirmed credits', async () => {
    rowsByKind[AccountMovementKind.CASHBACK_CREDITED] = [{ amount: 1000 }];
    rowsByKind[AccountMovementKind.CASHBACK_PAID_OUT] = [{ amount: 400 }];
    await expect(service.getCashbackOwed(companyId)).resolves.toBe(600);
  });

  it('reaches exactly zero once the whole balance has been paid', async () => {
    rowsByKind[AccountMovementKind.CASHBACK_CREDITED] = [{ amount: 1000 }];
    rowsByKind[AccountMovementKind.CASHBACK_PAID_OUT] = [{ amount: 600 }, { amount: 400 }];
    await expect(service.getCashbackOwed(companyId)).resolves.toBe(0);
  });

  it('is NOT the per-kind credited balance — the distinction FR-067 rests on', async () => {
    rowsByKind[AccountMovementKind.CASHBACK_CREDITED] = [{ amount: 1000 }];
    rowsByKind[AccountMovementKind.CASHBACK_PAID_OUT] = [{ amount: 400 }];

    const perKind = await service.getConfirmedBalance(
      companyId,
      AccountMovementKind.CASHBACK_CREDITED,
    );
    const owed = await service.getCashbackOwed(companyId);

    // The per-kind figure is unchanged by the payout and looks entirely
    // reasonable. Reusing it would violate FR-067 with no visible error.
    expect(perKind).toBe(1000);
    expect(owed).toBe(600);
    expect(owed).not.toBe(perKind);
  });

  it('honours reversals on both kinds', async () => {
    rowsByKind[AccountMovementKind.CASHBACK_CREDITED] = [
      { amount: 1000 },
      { amount: 200, reversalOfId: new Types.ObjectId() },
    ];
    rowsByKind[AccountMovementKind.CASHBACK_PAID_OUT] = [{ amount: 300 }];
    await expect(service.getCashbackOwed(companyId)).resolves.toBe(500);
  });
});

/** FR-064 — direction is total over the kinds and derived, never stored. */
describe('AccountMovementDirection is total over AccountMovementKind (FR-064)', () => {
  it('assigns a direction to every kind', () => {
    for (const kind of Object.values(AccountMovementKind)) {
      expect(directionForKind(kind)).toBeDefined();
    }
  });

  /**
   * Stated from the COMPANY's point of view, because the company is who reads
   * this ledger — SC-011 requires a payout to appear there "identified as
   * incoming". Money the company RECEIVES (a cashback credited to it, and the
   * payout that settles that credit) is INBOUND; money it PAYS (a commission
   * charged to it, a payment it made) is OUTBOUND.
   */
  it('points each kind the way the COMPANY experiences it (SC-011)', () => {
    const inbound = [
      AccountMovementKind.CASHBACK_CREDITED,
      AccountMovementKind.CASHBACK_PAID_OUT,
    ];
    const outbound = [
      AccountMovementKind.COMMISSION_CHARGED,
      AccountMovementKind.PAYMENT_RECORDED,
    ];

    for (const kind of inbound) {
      expect(directionForKind(kind)).toBe(AccountMovementDirection.INBOUND);
    }
    for (const kind of outbound) {
      expect(directionForKind(kind)).toBe(AccountMovementDirection.OUTBOUND);
    }
    // Total: the two lists together must name every kind, so a kind added
    // later fails here rather than silently defaulting to one direction.
    expect([...inbound, ...outbound].sort()).toEqual(
      Object.values(AccountMovementKind).sort(),
    );
  });

  /**
   * FR-064's actual purpose: a cashback the platform paid a company and a
   * payment that company made to the platform are two positive amounts, and
   * must be distinguishable.
   */
  it('separates a payout received from a payment made', () => {
    expect(directionForKind(AccountMovementKind.CASHBACK_PAID_OUT)).not.toBe(
      directionForKind(AccountMovementKind.PAYMENT_RECORDED),
    );
  });
});
