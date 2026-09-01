import { IsMongoId } from 'class-validator';

export class ReassignVehicleDto {
  @IsMongoId()
  truckId!: string;

  @IsMongoId()
  tankId!: string;
}
