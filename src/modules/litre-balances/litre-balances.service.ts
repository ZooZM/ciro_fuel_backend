import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { LitreBalance, LitreBalanceDocument } from './schemas/litre-balance.schema';
import { LitreMovementKind } from '../../common/enums/litre-movement-kind.enum';
import { FuelType } from '../../common/enums/fuel-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';

// Litres, unlike currency, are recorded to 3dp in this domain (the reference case:
// 31,501.100 L against 33,000 L -> 1,498.900 L credited).
function roundLitres(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const MAX_DRAWDOWN_ATTEMPTS = 5;

export interface ReconciliationResult {
  shortfallLitres: number;
  balanceLitres: number;
  wentNegative: boolean;
}

export interface DrawdownResult {
  litresDrawn: number;
  balanceRemaining: number;
}

@Injectable()
export class LitreBalancesService {
  private readonly logger = new Logger(LitreBalancesService.name);

  constructor(
    @InjectModel(LitreBalance.name) private readonly balanceModel: Model<LitreBalanceDocument>,
  ) {}

  private async findOrNull(
    companyId: string | Types.ObjectId,
    clientId: string | Types.ObjectId,
    fuelType: FuelType,
    session?: ClientSession,
  ): Promise<LitreBalanceDocument | null> {
    const query = this.balanceModel.findOne({ companyId, clientId, fuelType });
    if (session) query.session(session);
    return query.exec();
  }

  async getBalanceLitres(
    companyId: string | Types.ObjectId,
    clientId: string | Types.ObjectId,
    fuelType: FuelType,
    session?: ClientSession,
  ): Promise<number> {
    const balance = await this.findOrNull(companyId, clientId, fuelType, session);
    return balance?.balanceLitres ?? 0;
  }

  /**
   * T190/T191/FR-073c/FR-073d — `orderedLitres − suppliedLitres`: positive credits the
   * owner (a shortfall), negative debits (an excess). Exactly zero records NOTHING (T201's
   * "exact quantity -> no movement") — a zero-value movement would be noise, not a fact.
   * `wentNegative` is advisory only (T191/FR-073d — the movement still applies).
   *
   * The idempotency guard is the second write's own filter — `reconciledOrderIds: {$ne:
   * orderId}` — checked via a `null` result, corrected from an earlier draft that relied
   * on a unique index catching a duplicate `$push` into one document's own array.
   * MongoDB's unique-index constraint holds only BETWEEN documents, never within a single
   * document's own multikey entries, so that draft let a retried confirmation apply
   * twice — found by T205's own unit tests. Splitting into two writes (ensure the
   * document exists, THEN conditionally record) also fixes a second, subtler bug the
   * single-upsert draft had: two DIFFERENT orders reconciling for the same never-before-
   * seen client+grade at once would otherwise race to insert the first balance document,
   * and the loser would hit the SAME unique-key error and be wrongly refused as a
   * duplicate even though it was a wholly different order.
   */
  async recordReconciliation(
    companyId: string | Types.ObjectId,
    clientId: string | Types.ObjectId,
    fuelType: FuelType,
    orderId: string | Types.ObjectId,
    orderedLitres: number,
    suppliedLitres: number,
    actorId: string | Types.ObjectId,
    session: ClientSession,
  ): Promise<ReconciliationResult> {
    const shortfallLitres = roundLitres(orderedLitres - suppliedLitres);
    if (shortfallLitres === 0) {
      const balanceLitres = await this.getBalanceLitres(companyId, clientId, fuelType, session);
      return { shortfallLitres: 0, balanceLitres, wentNegative: false };
    }

    const orderIdObj = new Types.ObjectId(orderId);
    const kind =
      shortfallLitres > 0 ? LitreMovementKind.SHORTFALL_CREDIT : LitreMovementKind.EXCESS_DEBIT;

    // Step 1: the balance document exists, idempotently — never touches movements.
    await this.balanceModel
      .updateOne(
        { companyId, clientId, fuelType },
        { $setOnInsert: { companyId, clientId, fuelType, balanceLitres: 0 } },
        { upsert: true, session },
      )
      .exec();

    // Step 2: conditional on this order never having reconciled before — `null` (not an
    // exception) is what a genuine retry produces.
    const updated = await this.balanceModel
      .findOneAndUpdate(
        { companyId, clientId, fuelType, reconciledOrderIds: { $ne: orderIdObj } },
        {
          $inc: { balanceLitres: shortfallLitres },
          $push: {
            movements: {
              kind,
              litres: shortfallLitres,
              orderId: orderIdObj,
              actorId: new Types.ObjectId(actorId),
              at: new Date(),
            },
            reconciledOrderIds: orderIdObj,
          },
        },
        { new: true, session },
      )
      .exec();
    if (updated) {
      return {
        shortfallLitres,
        balanceLitres: updated.balanceLitres,
        wentNegative: updated.balanceLitres < 0,
      };
    }
    throw new ConflictException({
      error: ErrorCode.SUPPLIER_INVOICE_ALREADY_RECORDED,
      message: 'This order has already accrued a balance movement from a supplier invoice',
    });
  }

  /**
   * T192/FR-073e — the `PUT` replace path: reverses the prior movement (if the prior
   * confirmation actually produced one — an exact-quantity prior confirm left nothing to
   * reverse) then applies the new one, as two sequential writes inside the SAME transaction
   * the caller already holds. Never a second `SHORTFALL_CREDIT`/`EXCESS_DEBIT` alongside
   * the first — this is what "restate, never accrue a second movement" means structurally.
   */
  async restateReconciliation(
    companyId: string | Types.ObjectId,
    clientId: string | Types.ObjectId,
    fuelType: FuelType,
    orderId: string | Types.ObjectId,
    orderedLitres: number,
    suppliedLitres: number,
    actorId: string | Types.ObjectId,
    session: ClientSession,
  ): Promise<ReconciliationResult> {
    const orderIdObj = new Types.ObjectId(orderId);
    const existing = await this.findOrNull(companyId, clientId, fuelType, session);
    const priorMovement = existing?.movements.find(
      (m) =>
        m.orderId &&
        String(m.orderId) === String(orderIdObj) &&
        (m.kind === LitreMovementKind.SHORTFALL_CREDIT ||
          m.kind === LitreMovementKind.EXCESS_DEBIT),
    );

    if (priorMovement) {
      await this.balanceModel
        .updateOne(
          { _id: existing!._id },
          {
            $inc: { balanceLitres: -priorMovement.litres },
            $pull: { movements: { _id: priorMovement._id }, reconciledOrderIds: orderIdObj },
          },
          { session },
        )
        .exec();
    }

    return this.recordReconciliation(
      companyId,
      clientId,
      fuelType,
      orderId,
      orderedLitres,
      suppliedLitres,
      actorId,
      session,
    );
  }

  /**
   * T194/R9 — draws at most `min(currentBalance, requestedLitres)` down, inside the
   * caller's order-creation transaction. `requestedLitres` is the NEW order's own quantity
   * — drawdown can never exceed what is actually being ordered (there is nothing to draw
   * "into" beyond that). The conditional update carries the expected balance read moments
   * earlier; a concurrent order for the same owner/grade that already moved it makes this
   * match nothing, and the loop re-reads and retries rather than silently overwriting a
   * balance it no longer has an accurate picture of (this is what makes two orders placed
   * at once unable to both consume the same litres).
   */
  async drawdown(
    companyId: string | Types.ObjectId,
    clientId: string | Types.ObjectId,
    fuelType: FuelType,
    orderId: string | Types.ObjectId,
    requestedLitres: number,
    actorId: string | Types.ObjectId,
    session: ClientSession,
  ): Promise<DrawdownResult> {
    const orderIdObj = new Types.ObjectId(orderId);
    for (let attempt = 0; attempt < MAX_DRAWDOWN_ATTEMPTS; attempt++) {
      const current = await this.findOrNull(companyId, clientId, fuelType, session);
      const availableLitres = current?.balanceLitres ?? 0;
      if (availableLitres <= 0) {
        return { litresDrawn: 0, balanceRemaining: Math.max(availableLitres, 0) };
      }
      const litresDrawn = roundLitres(Math.min(availableLitres, requestedLitres));
      if (litresDrawn <= 0) {
        return { litresDrawn: 0, balanceRemaining: availableLitres };
      }

      const result = await this.balanceModel
        .findOneAndUpdate(
          { _id: current!._id, balanceLitres: current!.balanceLitres },
          {
            $inc: { balanceLitres: -litresDrawn },
            $push: {
              movements: {
                kind: LitreMovementKind.ORDER_DRAWDOWN,
                litres: -litresDrawn,
                orderId: orderIdObj,
                actorId: new Types.ObjectId(actorId),
                at: new Date(),
              },
            },
          },
          { new: true, session },
        )
        .exec();
      if (result) {
        return { litresDrawn, balanceRemaining: result.balanceLitres };
      }
      this.logger.debug(`Litre balance drawdown conflict, retrying (attempt ${attempt + 1})`);
    }
    throw new ConflictException('Could not draw down the litre balance — please retry');
  }

  /** T196/R9 — the read-only projection `POST /orders/quote` uses. A quote MUST consume
   * nothing (a quote that moved the balance would leak litres on every abandoned quote) —
   * this never writes, it only reports what a real order of this size would draw. */
  async projectDrawdown(
    companyId: string | Types.ObjectId,
    clientId: string | Types.ObjectId,
    fuelType: FuelType,
    requestedLitres: number,
  ): Promise<DrawdownResult> {
    const availableLitres = await this.getBalanceLitres(companyId, clientId, fuelType);
    const litresDrawn = roundLitres(Math.max(0, Math.min(availableLitres, requestedLitres)));
    return { litresDrawn, balanceRemaining: roundLitres(availableLitres - litresDrawn) };
  }

  /**
   * T197 — reverses a prior `ORDER_DRAWDOWN` on cancellation, as a `DRAWDOWN_RETURNED`
   * movement (never a delete — the drawdown itself stays in the history, same discipline
   * as every reversal elsewhere on this platform). A no-op if this order never drew
   * anything down (an order placed with no balance available, or already returned).
   */
  async returnDrawdown(
    companyId: string | Types.ObjectId,
    clientId: string | Types.ObjectId,
    fuelType: FuelType,
    orderId: string | Types.ObjectId,
    actorId: string | Types.ObjectId,
    session: ClientSession,
  ): Promise<void> {
    const orderIdObj = new Types.ObjectId(orderId);
    const balance = await this.findOrNull(companyId, clientId, fuelType, session);
    if (!balance) return;

    const alreadyReturned = balance.movements.some(
      (m) =>
        m.orderId &&
        String(m.orderId) === String(orderIdObj) &&
        m.kind === LitreMovementKind.DRAWDOWN_RETURNED,
    );
    if (alreadyReturned) return;

    const drawdown = balance.movements.find(
      (m) =>
        m.orderId &&
        String(m.orderId) === String(orderIdObj) &&
        m.kind === LitreMovementKind.ORDER_DRAWDOWN,
    );
    if (!drawdown) return;

    await this.balanceModel
      .updateOne(
        { _id: balance._id },
        {
          $inc: { balanceLitres: -drawdown.litres },
          $push: {
            movements: {
              kind: LitreMovementKind.DRAWDOWN_RETURNED,
              litres: -drawdown.litres,
              orderId: orderIdObj,
              actorId: new Types.ObjectId(actorId),
              at: new Date(),
            },
          },
        },
        { session },
      )
      .exec();
  }

  /**
   * T199/FR-074a/FR-075 — a direct administrator correction against an EXISTING balance
   * (the route is `/litre-balances/:id/corrections`; a correction has nothing to create
   * from scratch, only an existing balance to adjust). `findById` runs through the
   * tenant-scope plugin, so a cross-company id 404s before this ever checks anything else
   * — the same discipline `files.controller.ts:download` relies on. `reason` is required
   * (checked here, not by the schema, since it's conditional on `kind` for the shared
   * `LitreMovement` sub-schema).
   */
  async recordCorrection(
    id: string,
    litres: number,
    reason: string,
    actorId: string | Types.ObjectId,
  ): Promise<LitreBalanceDocument> {
    if (!reason || !reason.trim()) {
      throw new BadRequestException({
        error: ErrorCode.BALANCE_CORRECTION_REASON_REQUIRED,
        message: 'A reason is required to correct a litre balance',
      });
    }
    const existing = await this.balanceModel.findById(id).exec();
    if (!existing) {
      throw new NotFoundException('Litre balance not found');
    }
    const roundedLitres = roundLitres(litres);
    const updated = await this.balanceModel
      .findByIdAndUpdate(
        id,
        {
          $inc: { balanceLitres: roundedLitres },
          $push: {
            movements: {
              kind: LitreMovementKind.CORRECTION,
              litres: roundedLitres,
              reason: reason.trim(),
              actorId: new Types.ObjectId(actorId),
              at: new Date(),
            },
          },
        },
        { new: true },
      )
      .exec();
    return updated!;
  }

  /** T198 — the FCA's own listing, optionally for one client. */
  listForCompany(clientId?: string): Promise<LitreBalanceDocument[]> {
    const query: Record<string, unknown> = {};
    if (clientId) query.clientId = new Types.ObjectId(clientId);
    return this.balanceModel.find(query).sort({ fuelType: 1 }).exec();
  }

  /** T198 — the station owner's own balances, movements included (FR-075a, FR-076). */
  listForClient(clientId: string): Promise<LitreBalanceDocument[]> {
    return this.balanceModel
      .find({ clientId: new Types.ObjectId(clientId) })
      .sort({ fuelType: 1 })
      .exec();
  }
}
