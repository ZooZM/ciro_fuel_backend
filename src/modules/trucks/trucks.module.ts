import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Truck, TruckSchema } from './schemas/truck.schema';
import { TrucksService } from './trucks.service';
import { TrucksController } from './trucks.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: Truck.name, schema: TruckSchema }])],
  controllers: [TrucksController],
  providers: [TrucksService],
  exports: [TrucksService, MongooseModule],
})
export class TrucksModule {}
