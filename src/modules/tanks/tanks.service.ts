import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Tank, TankDocument } from './schemas/tank.schema';
import { FuelType } from '../../common/enums/fuel-type.enum';
import { ErrorCode } from '../../common/enums/error-code.enum';
import { CreateTankDto } from './dto/create-tank.dto';
import { UpdateTankDto } from './dto/update-tank.dto';

const MONGO_DUPLICATE_KEY = 11000;

@Injectable()
export class TanksService {
  constructor(@InjectModel(Tank.name) private readonly tankModel: Model<TankDocument>) {}

  /**
   * FR-048b: catches the duplicate-key violation on the globally-unique
   * `code` rather than a prior existence check — same discipline as
   * `TrucksService.pairCard`. Deliberately generic: the conflict message
   * never names which company already holds the code (data-model.md).
   */
  create(companyId: string, dto: CreateTankDto): Promise<TankDocument> {
    return this.tankModel
      .create({
        companyId: new Types.ObjectId(companyId),
        code: dto.code,
        material: dto.material,
        maxCapacityLiters: dto.maxCapacityLiters,
        fuelTypes: dto.fuelTypes,
      })
      .catch((err) => {
        if (err?.code === MONGO_DUPLICATE_KEY) {
          throw new ConflictException({
            error: ErrorCode.TANK_CODE_IN_USE,
            message: 'This tank code is already in use',
          });
        }
        throw err;
      });
  }

  async findAll(companyId: string): Promise<{ items: TankDocument[]; fleetRegistered: boolean }> {
    const totalCount = await this.tankModel.countDocuments({ companyId }).exec();
    const items = await this.tankModel.find({ companyId }).sort({ code: 1 }).exec();
    return { items, fleetRegistered: totalCount > 0 };
  }

  async findById(id: string): Promise<TankDocument> {
    const tank = await this.tankModel.findById(id).exec();
    if (!tank) {
      throw new NotFoundException('Tank not found');
    }
    return tank;
  }

  /**
   * FR-016a: the offered list pre-excludes tanks the platform would refuse
   * at assignment anyway (below the order's quantity, or not permitted its
   * grade) — so what an operator is offered and what the platform would
   * accept always agree.
   */
  forOrderId(
    companyId: string,
    quantityLiters: number,
    fuelType: FuelType,
  ): Promise<TankDocument[]> {
    return this.tankModel
      .find({
        companyId,
        isActive: true,
        activeOrderId: { $exists: false },
        maxCapacityLiters: { $gte: quantityLiters },
        fuelTypes: fuelType,
      })
      .sort({ code: 1 })
      .exec();
  }

  async update(id: string, dto: UpdateTankDto): Promise<TankDocument> {
    try {
      const tank = await this.tankModel
        .findOneAndUpdate(
          { _id: id },
          {
            $set: {
              ...(dto.code != null ? { code: dto.code } : {}),
              // FR-048g: `material` is recorded fact only — updating it here
              // never touches `fuelTypes`, and vice versa; the two fields
              // are set independently, with no derivation between them.
              ...(dto.material != null ? { material: dto.material } : {}),
              ...(dto.maxCapacityLiters != null
                ? { maxCapacityLiters: dto.maxCapacityLiters }
                : {}),
              ...(dto.fuelTypes != null ? { fuelTypes: dto.fuelTypes } : {}),
            },
          },
          { new: true },
        )
        .exec();
      if (!tank) {
        throw new NotFoundException('Tank not found');
      }
      return tank;
    } catch (err: unknown) {
      if ((err as { code?: number })?.code === MONGO_DUPLICATE_KEY) {
        throw new ConflictException({
          error: ErrorCode.TANK_CODE_IN_USE,
          message: 'This tank code is already in use',
        });
      }
      throw err;
    }
  }

  async withdraw(id: string): Promise<TankDocument> {
    const tank = await this.tankModel
      .findOneAndUpdate({ _id: id }, { $set: { isActive: false } }, { new: true })
      .exec();
    if (!tank) {
      throw new NotFoundException('Tank not found');
    }
    return tank;
  }

  async restore(id: string): Promise<TankDocument> {
    const tank = await this.tankModel
      .findOneAndUpdate({ _id: id }, { $set: { isActive: true } }, { new: true })
      .exec();
    if (!tank) {
      throw new NotFoundException('Tank not found');
    }
    return tank;
  }
}
