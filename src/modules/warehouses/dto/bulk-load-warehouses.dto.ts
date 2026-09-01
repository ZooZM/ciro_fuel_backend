import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { CreateWarehouseDto } from './create-warehouse.dto';

/**
 * FR-035a: the operator's national-dataset bulk load. Each entry mirrors
 * `CreateWarehouseDto` plus `externalRef` (already optional there, but a
 * bulk load without it can never be re-run idempotently — the service does
 * not enforce that here, matching `externalRef`'s optionality elsewhere;
 * see `WarehousesService.bulkLoad`'s own doc comment for what an absent one
 * means for a given entry).
 */
export class BulkLoadWarehousesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateWarehouseDto)
  warehouses!: CreateWarehouseDto[];
}
