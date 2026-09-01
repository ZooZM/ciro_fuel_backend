import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Warehouse, WarehouseDocument } from './schemas/warehouse.schema';
import { FuelType } from '../../common/enums/fuel-type.enum';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';

@Injectable()
export class WarehousesService {
  constructor(
    @InjectModel(Warehouse.name) private readonly warehouseModel: Model<WarehouseDocument>,
  ) {}

  /** Open to every authenticated role (FR-035c) — no scoping to apply, `Warehouse` has none. */
  findAll(): Promise<WarehouseDocument[]> {
    return this.warehouseModel.find().sort({ name: 1 }).exec();
  }

  async findById(id: string): Promise<WarehouseDocument> {
    const warehouse = await this.warehouseModel.findById(id).exec();
    if (!warehouse) {
      throw new NotFoundException('Warehouse not found');
    }
    return warehouse;
  }

  create(dto: CreateWarehouseDto): Promise<WarehouseDocument> {
    return this.warehouseModel.create({
      name: dto.name,
      location: { type: 'Point', coordinates: [dto.location.longitude, dto.location.latitude] },
      addressText: dto.addressText,
      region: dto.region,
      governorate: dto.governorate,
      fuelTypes: dto.fuelTypes,
      externalRef: dto.externalRef,
    });
  }

  /**
   * FR-035a: idempotent — upserts on `externalRef` so re-loading the
   * national dataset updates existing rows rather than duplicating them.
   * An entry with no `externalRef` is always inserted fresh (it has no
   * identity to upsert against).
   */
  async bulkLoad(entries: CreateWarehouseDto[]): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;
    for (const dto of entries) {
      const doc = {
        name: dto.name,
        location: { type: 'Point', coordinates: [dto.location.longitude, dto.location.latitude] },
        addressText: dto.addressText,
        region: dto.region,
        governorate: dto.governorate,
        fuelTypes: dto.fuelTypes,
        ...(dto.externalRef ? { externalRef: dto.externalRef } : {}),
      };
      if (dto.externalRef) {
        const result = await this.warehouseModel
          .updateOne({ externalRef: dto.externalRef }, { $set: doc }, { upsert: true })
          .exec();
        if (result.upsertedCount > 0) {
          created += 1;
        } else {
          updated += 1;
        }
      } else {
        await this.warehouseModel.create(doc);
        created += 1;
      }
    }
    return { created, updated };
  }

  async update(id: string, dto: UpdateWarehouseDto): Promise<WarehouseDocument> {
    const warehouse = await this.warehouseModel
      .findOneAndUpdate(
        { _id: id },
        {
          $set: {
            ...(dto.name != null ? { name: dto.name } : {}),
            ...(dto.location != null
              ? {
                  location: {
                    type: 'Point',
                    coordinates: [dto.location.longitude, dto.location.latitude],
                  },
                }
              : {}),
            ...(dto.addressText != null ? { addressText: dto.addressText } : {}),
            ...(dto.region != null ? { region: dto.region } : {}),
            ...(dto.governorate != null ? { governorate: dto.governorate } : {}),
            ...(dto.fuelTypes != null ? { fuelTypes: dto.fuelTypes } : {}),
            ...(dto.externalRef != null ? { externalRef: dto.externalRef } : {}),
          },
        },
        { new: true },
      )
      .exec();
    if (!warehouse) {
      throw new NotFoundException('Warehouse not found');
    }
    return warehouse;
  }

  async withdraw(id: string): Promise<WarehouseDocument> {
    const warehouse = await this.warehouseModel
      .findOneAndUpdate({ _id: id }, { $set: { isActive: false } }, { new: true })
      .exec();
    if (!warehouse) {
      throw new NotFoundException('Warehouse not found');
    }
    return warehouse;
  }

  /**
   * FR-035d/FR-035f: the nearest in-service warehouse that supplies the
   * requested grade — the `query` pre-filter on a `$geoNear` aggregate,
   * same shape as `DispatchService.findCandidates`. `Warehouse` carries no
   * scoping plugin, so unlike that query this needs no tenant awareness at
   * all (research R1/R9). Returns `null` when none supplies the grade —
   * callers surface `NO_WAREHOUSE_FOR_GRADE` to the operator, never the driver.
   */
  async findNearestSupplying(
    coordinates: [number, number],
    fuelType: FuelType,
  ): Promise<WarehouseDocument | null> {
    const [nearest] = await this.warehouseModel.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates },
          distanceField: 'distanceMeters',
          spherical: true,
          query: { isActive: true, fuelTypes: fuelType },
        },
      },
      { $limit: 1 },
    ]);
    return nearest ?? null;
  }
}
