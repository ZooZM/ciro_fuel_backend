import { IsMongoId } from 'class-validator';

export class RouteOrderDto {
  @IsMongoId()
  transportCompanyId!: string;
}
