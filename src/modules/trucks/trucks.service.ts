import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { Truck, TruckDocument } from './schemas/truck.schema';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { CreateTruckDto } from './dto/create-truck.dto';
import { UpdateTruckDto } from './dto/update-truck.dto';
import { normalizeCardUid } from '../../common/utils/card-uid.util';

// Mongo's duplicate-key error code — used throughout the codebase to catch a
// unique-index violation rather than a doomed prior existence check (see
// PasswordResetService, StationsService's siblings).
const MONGO_DUPLICATE_KEY = 11000;

@Injectable()
export class TrucksService {
  constructor(@InjectModel(Truck.name) private readonly truckModel: Model<TruckDocument>) {}

  create(companyId: string, dto: CreateTruckDto): Promise<TruckDocument> {
    return this.truckModel
      .create({
        companyId: new Types.ObjectId(companyId),
        plateNumber: dto.plateNumber,
        model: dto.model,
      })
      .catch((err) => {
        if (err?.code === MONGO_DUPLICATE_KEY) {
          throw new ConflictException({
            error: ErrorCode.DUPLICATE_PLATE,
            message: 'A truck with this plate number already exists for your company',
          });
        }
        throw err;
      });
  }

  /**
   * FR-043c: distinguishes "no trucks registered at all" from "trucks exist
   * but none is currently available" via `fleetRegistered` — an
   * operator-facing surface uses this to say a fleet needs registering
   * rather than showing an unexplained empty picker, instead of inferring
   * it from an empty `items` array (which both cases would otherwise share).
   */
  async findAll(
    companyId: string,
    options: { availableOnly?: boolean } = {},
  ): Promise<{ items: TruckDocument[]; fleetRegistered: boolean }> {
    const totalCount = await this.truckModel.countDocuments({ companyId }).exec();
    const filter: Record<string, unknown> = { companyId };
    if (options.availableOnly) {
      filter.isActive = true;
      filter.activeOrderId = { $exists: false };
    }
    const items = await this.truckModel.find(filter).sort({ plateNumber: 1 }).exec();
    return { items, fleetRegistered: totalCount > 0 };
  }

  async findById(id: string): Promise<TruckDocument> {
    const truck = await this.truckModel.findById(id).exec();
    if (!truck) {
      throw new NotFoundException('Truck not found');
    }
    return truck;
  }

  async update(id: string, dto: UpdateTruckDto): Promise<TruckDocument> {
    try {
      const truck = await this.truckModel
        .findOneAndUpdate(
          { _id: id },
          {
            $set: {
              ...(dto.plateNumber != null ? { plateNumber: dto.plateNumber } : {}),
              ...(dto.model != null ? { model: dto.model } : {}),
            },
          },
          { new: true },
        )
        .exec();
      if (!truck) {
        throw new NotFoundException('Truck not found');
      }
      return truck;
    } catch (err: unknown) {
      if ((err as { code?: number })?.code === MONGO_DUPLICATE_KEY) {
        throw new ConflictException({
          error: ErrorCode.DUPLICATE_PLATE,
          message: 'A truck with this plate number already exists for your company',
        });
      }
      throw err;
    }
  }

  /** FR-007: withdrawn from service. Never touches `activeOrderId` (FR-008). */
  async withdraw(id: string): Promise<TruckDocument> {
    const truck = await this.truckModel
      .findOneAndUpdate({ _id: id }, { $set: { isActive: false } }, { new: true })
      .exec();
    if (!truck) {
      throw new NotFoundException('Truck not found');
    }
    return truck;
  }

  async restore(id: string): Promise<TruckDocument> {
    const truck = await this.truckModel
      .findOneAndUpdate({ _id: id }, { $set: { isActive: true } }, { new: true })
      .exec();
    if (!truck) {
      throw new NotFoundException('Truck not found');
    }
    return truck;
  }

  /**
   * FR-005: catches the duplicate-key violation on `nfcCardUid` rather than
   * checking for prior existence first — two concurrent pairings against the
   * same card would both pass a prior check, but only one can win the
   * unique index (SC-008). FR-036e: pairing a new card also clears any
   * previously minted `qrToken` — a superseded credential cannot keep
   * verifying.
   *
   * Feature 009 FR-050: the dashboard must name the tractor already holding
   * a card it failed to pair. The lookup below runs only AFTER the unique
   * index has already rejected the write — it is not a prior-existence
   * check and reintroduces no race (the plate returned may itself be
   * mid-change by the time the operator reads it, which is an acceptable,
   * informational best-effort, not a correctness guarantee).
   */
  async pairCard(id: string, rawCardUid: string): Promise<TruckDocument> {
    // Stored canonical, never as the desk reader happened to render it — the
    // driver's phone will render the same card differently, and only a shared
    // canonical form makes the two comparable (card-uid.util.ts).
    const nfcCardUid = normalizeCardUid(rawCardUid);
    if (!nfcCardUid) {
      throw new BadRequestException('A card identifier is required');
    }
    try {
      const truck = await this.truckModel
        .findOneAndUpdate(
          { _id: id },
          { $set: { nfcCardUid }, $unset: { qrToken: '' } },
          { new: true },
        )
        .exec();
      if (!truck) {
        throw new NotFoundException('Truck not found');
      }
      return truck;
    } catch (err: unknown) {
      if ((err as { code?: number })?.code === MONGO_DUPLICATE_KEY) {
        const holder = await this.truckModel.findOne({ nfcCardUid }).exec();
        throw new ConflictException({
          error: ErrorCode.CARD_ALREADY_PAIRED,
          message: 'This NFC card is already paired to another truck',
          heldByTruckId: holder ? String(holder._id) : null,
          heldByPlateNumber: holder?.plateNumber ?? null,
        });
      }
      throw err;
    }
  }

  /**
   * FR-036b/research R6: mints a fresh, cryptographically random,
   * high-entropy `qrToken` — never derived from the truck's `_id` (an
   * id-bearing code would be forgeable and unrevocable). Coexists with the
   * NFC card (FR-036d) — minting one does not disturb the other.
   */
  async mintQrToken(id: string): Promise<{ truck: TruckDocument; qrToken: string }> {
    const qrToken = randomBytes(24).toString('base64url');
    const truck = await this.truckModel
      .findOneAndUpdate({ _id: id }, { $set: { qrToken } }, { new: true })
      .exec();
    if (!truck) {
      throw new NotFoundException('Truck not found');
    }
    return { truck, qrToken };
  }

  /** FR-036b: revoking a leaked code is a token rotation, never an expiry wait. */
  rotateQrToken(id: string): Promise<{ truck: TruckDocument; qrToken: string }> {
    return this.mintQrToken(id);
  }

  /** FR-036: revokes without minting a replacement — the truck falls back to card-only. */
  async revokeQrToken(id: string): Promise<TruckDocument> {
    const truck = await this.truckModel
      .findOneAndUpdate({ _id: id }, { $unset: { qrToken: '' } }, { new: true })
      .exec();
    if (!truck) {
      throw new NotFoundException('Truck not found');
    }
    return truck;
  }
}
