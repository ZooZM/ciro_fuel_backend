import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { Company, CompanySchema } from '../companies/schemas/company.schema';
import { Truck, TruckSchema } from '../trucks/schemas/truck.schema';
import { DriversService } from './drivers.service';
import { DriverRosterService } from './driver-roster.service';
import { DriversController } from './drivers.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Order.name, schema: OrderSchema },
      // spec 017 T086 — the roster names each driver's employer and their most
      // recently operated truck, so it reads both collections directly rather
      // than importing CompaniesModule/TrucksModule for one projection each.
      { name: Company.name, schema: CompanySchema },
      { name: Truck.name, schema: TruckSchema },
    ]),
  ],
  controllers: [DriversController],
  providers: [DriversService, DriverRosterService],
  exports: [DriversService, DriverRosterService],
})
export class DriversModule {}
