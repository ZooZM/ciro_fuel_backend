import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createTestApp, TestAppContext } from '../utils/test-app.factory';
import { seedThreeFuelCompanies, ThreeFuelCompanyFixture } from '../utils/fixtures';
import { TenantContextService } from '../../src/common/context/tenant-context.service';
import { ExchangeOffer, ExchangeOfferDocument } from '../../src/modules/fuel-exchange/schemas/exchange-offer.schema';
import { ExchangeProposal, ExchangeProposalDocument } from '../../src/modules/fuel-exchange/schemas/exchange-proposal.schema';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { ExchangeOfferState } from '../../src/common/enums/exchange-offer-state.enum';
import { ProposalOutcome } from '../../src/common/enums/proposal-outcome.enum';

jest.setTimeout(120_000);

/**
 * spec 016 (broadcast fuel exchange offers) T024/T025 — Slice 0's gate (T026): every
 * non-negotiable case in `contracts/isolation-contract.md`, over the THREE-fuel-company
 * fixture research R11 requires (blindness needs a SECOND eligible company, not merely
 * an ineligible third party). Built with no service and no controller — direct model
 * access under `TenantContextService.run`, exactly `party-set-isolation.e2e-spec.ts`'s
 * own Part-A shape. Grade eligibility is NOT tested here (research R2: it is a
 * service-layer relevance filter, not an isolation boundary) — only that a market offer
 * is readable by a fuel company regardless of party membership, and that a migrated
 * directed offer is not.
 */
describe('Exchange offer isolation (Slice 0 gate, contracts/isolation-contract.md)', () => {
  let ctx: TestAppContext;
  let app: INestApplication;
  let fixtures: ThreeFuelCompanyFixture;
  let offerModel: Model<ExchangeOfferDocument>;
  let proposalModel: Model<ExchangeProposalDocument>;
  let tenantContext: TenantContextService;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
    fixtures = await seedThreeFuelCompanies(app);
    offerModel = app.get(getModelToken(ExchangeOffer.name));
    proposalModel = app.get(getModelToken(ExchangeProposal.name));
    tenantContext = app.get(TenantContextService);
  }, 180_000);

  afterAll(async () => {
    await ctx.close();
  }, 30_000);

  afterEach(async () => {
    await offerModel.deleteMany({});
    await proposalModel.deleteMany({});
  });

  function asCompany<T>(companyId: string, userId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ userId, role: UserRole.FUEL_COMPANY_ADMIN, companyId }, fn);
  }

  async function raiseMarketOffer() {
    const { admin, companyId } = fixtures.companyA;
    return asCompany(companyId, admin.id, () =>
      offerModel.create({
        openToMarket: true,
        partyCompanyIds: [new Types.ObjectId(companyId)],
        raisedByCompanyId: new Types.ObjectId(companyId),
        raisedByUserId: new Types.ObjectId(admin.id),
        fuelType: 'PETROL_95',
        quantityLitres: 5000,
        deliveryAt: new Date('2026-09-20'),
        city: 'JEDDAH',
        state: ExchangeOfferState.OPEN,
      }),
    );
  }

  async function raiseMigratedDirectedOffer() {
    const { companyId: companyIdA } = fixtures.companyA;
    const { companyId: companyIdB } = fixtures.companyB;
    // A migrated record is written directly (the migration bypasses the ambient
    // context entirely, matching scripts/migrate-exchange-requests-to-offers.ts) —
    // never through `tenantContext.run`, since the migration itself runs unscoped.
    return offerModel.create({
      openToMarket: false,
      partyCompanyIds: [new Types.ObjectId(companyIdA), new Types.ObjectId(companyIdB)],
      raisedByCompanyId: new Types.ObjectId(companyIdA),
      raisedByUserId: new Types.ObjectId(fixtures.companyA.admin.id),
      fuelType: 'PETROL_95',
      quantityLitres: 5000,
      deliveryAt: new Date('2026-09-20'),
      city: 'RIYADH_CITY',
      state: ExchangeOfferState.OPEN,
      migratedFromRequestId: new Types.ObjectId(),
    });
  }

  // --- Case 1: a non-party company reads a MARKET offer by id — succeeds -----------

  it('1. company C, party to nothing, reads a market offer by id (R2: market offers are public to fuel companies)', async () => {
    const offer = await raiseMarketOffer();
    const { admin, companyId } = fixtures.companyC;
    const found = await asCompany(companyId, admin.id, () => offerModel.findById(offer._id).exec());
    expect(found).not.toBeNull();
    expect(String(found!._id)).toBe(String(offer._id));
  });

  // --- Case 2: a non-party company reads a MIGRATED DIRECTED offer by id — 404-shaped ---

  it('2. company C reads a migrated directed offer by id — indistinguishable from absence', async () => {
    const offer = await raiseMigratedDirectedOffer();
    const { admin, companyId } = fixtures.companyC;
    const found = await asCompany(companyId, admin.id, () => offerModel.findById(offer._id).exec());
    expect(found).toBeNull();
  });

  // --- Case 3: listing — migrated directed offer absent; market offer present -------

  it('3. company C lists offers: the migrated directed offer is absent; the market offer is present (grade relevance is a service-layer concern, not isolation)', async () => {
    const marketOffer = await raiseMarketOffer();
    await raiseMigratedDirectedOffer();
    const { admin, companyId } = fixtures.companyC;
    const results = await asCompany(companyId, admin.id, () => offerModel.find({}).exec());
    const ids = results.map((r) => String(r._id));
    expect(ids).toContain(String(marketOffer._id));
    expect(ids).toHaveLength(1);
  });

  // --- Case 4: a proposer sees only its OWN proposal, never a rival's --------------

  it("4. company B, having proposed, reads the proposal list: only its own — no rival price, no rival name, in the raw payload", async () => {
    const offer = await raiseMarketOffer();
    const { admin: adminB, companyId: companyIdB } = fixtures.companyB;
    const { admin: adminC, companyId: companyIdC } = fixtures.companyC;

    await asCompany(companyIdB, adminB.id, () =>
      proposalModel.create({
        offerId: offer._id,
        offerRaisedByCompanyId: offer.raisedByCompanyId,
        proposingCompanyId: new Types.ObjectId(companyIdB),
        proposingUserId: new Types.ObjectId(adminB.id),
        outcome: ProposalOutcome.PROPOSED,
        unitPrice: 2.2,
        currency: 'SAR',
        respondedAt: new Date(),
      }),
    );
    await asCompany(companyIdC, adminC.id, () =>
      proposalModel.create({
        offerId: offer._id,
        offerRaisedByCompanyId: offer.raisedByCompanyId,
        proposingCompanyId: new Types.ObjectId(companyIdC),
        proposingUserId: new Types.ObjectId(adminC.id),
        outcome: ProposalOutcome.PROPOSED,
        unitPrice: 9.99,
        currency: 'SAR',
        respondedAt: new Date(),
      }),
    );

    const seenByB = await asCompany(companyIdB, adminB.id, () => proposalModel.find({ offerId: offer._id }).exec());
    expect(seenByB).toHaveLength(1);
    expect(String(seenByB[0].proposingCompanyId)).toBe(companyIdB);
    expect(seenByB[0].unitPrice).toBe(2.2);
    // The raw payload contains no trace of the rival's price or identity.
    const serialized = JSON.stringify(seenByB.map((p) => p.toObject()));
    expect(serialized).not.toContain('9.99');
    expect(serialized).not.toContain(companyIdC);
  });

  // --- Case 5: the raiser sees BOTH proposals and both proposers' contacts ---------

  it('5. company A (raiser) reads the same offer: sees both proposals', async () => {
    const offer = await raiseMarketOffer();
    const { admin: adminB, companyId: companyIdB } = fixtures.companyB;
    const { admin: adminC, companyId: companyIdC } = fixtures.companyC;
    await asCompany(companyIdB, adminB.id, () =>
      proposalModel.create({
        offerId: offer._id,
        offerRaisedByCompanyId: offer.raisedByCompanyId,
        proposingCompanyId: new Types.ObjectId(companyIdB),
        proposingUserId: new Types.ObjectId(adminB.id),
        unitPrice: 2.2,
        currency: 'SAR',
        respondedAt: new Date(),
      }),
    );
    await asCompany(companyIdC, adminC.id, () =>
      proposalModel.create({
        offerId: offer._id,
        offerRaisedByCompanyId: offer.raisedByCompanyId,
        proposingCompanyId: new Types.ObjectId(companyIdC),
        proposingUserId: new Types.ObjectId(adminC.id),
        unitPrice: 2.6,
        currency: 'SAR',
        respondedAt: new Date(),
      }),
    );

    const { admin: adminA, companyId: companyIdA } = fixtures.companyA;
    const seenByA = await asCompany(companyIdA, adminA.id, () =>
      proposalModel.find({ offerId: offer._id }).exec(),
    );
    expect(seenByA).toHaveLength(2);
  });

  // --- Case 6: an unrecognised role throws, never returns empty --------------------

  it('6. a TRANSPORT_COMPANY_ADMIN, CLIENT or DRIVER context reaching the offer collection throws, not empty results', async () => {
    await raiseMarketOffer();
    for (const role of [UserRole.TRANSPORT_COMPANY_ADMIN, UserRole.CLIENT, UserRole.DRIVER]) {
      await expect(
        tenantContext.run({ userId: 'someone', role, companyId: fixtures.companyC.companyId }, () =>
          offerModel.find({}).exec(),
        ),
      ).rejects.toThrow(/no scoping rule/i);
    }
  });

  it('6b. the same holds for the proposal collection', async () => {
    for (const role of [UserRole.TRANSPORT_COMPANY_ADMIN, UserRole.CLIENT, UserRole.DRIVER]) {
      await expect(
        tenantContext.run({ userId: 'someone', role, companyId: fixtures.companyC.companyId }, () =>
          proposalModel.find({}).exec(),
        ),
      ).rejects.toThrow(/no scoping rule/i);
    }
  });

  // --- Case 7: SUPER_ADMIN reads everything (action refusals are Phase 5's concern) --

  it('7. SUPER_ADMIN reads every offer across every company', async () => {
    await raiseMarketOffer();
    await raiseMigratedDirectedOffer();
    await tenantContext.run({ userId: fixtures.superAdmin.id, role: UserRole.SUPER_ADMIN }, async () => {
      const results = await offerModel.find({}).exec();
      expect(results).toHaveLength(2);
    });
  });

  // --- Case 8: a migrated UNANSWERED request stays readable by its original recipient
  //     alone, never by any other company (FR-006b, FR-039a, SC-010) ------------------

  it('8. a migrated unanswered request is readable by its original recipient and nobody else', async () => {
    const offer = await raiseMigratedDirectedOffer(); // parties: A (raiser), B (recipient)
    const { admin: adminB, companyId: companyIdB } = fixtures.companyB;
    const { admin: adminC, companyId: companyIdC } = fixtures.companyC;

    const seenByRecipient = await asCompany(companyIdB, adminB.id, () => offerModel.findById(offer._id).exec());
    expect(seenByRecipient).not.toBeNull();

    const seenByOutsider = await asCompany(companyIdC, adminC.id, () => offerModel.findById(offer._id).exec());
    expect(seenByOutsider).toBeNull();
  });
});
