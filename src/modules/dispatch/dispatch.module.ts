import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Company, CompanySchema } from '../companies/schemas/company.schema';
import { Truck, TruckSchema } from '../trucks/schemas/truck.schema';
import { Tank, TankSchema } from '../tanks/schemas/tank.schema';
import { DispatchService } from './services/dispatch.service';
import { RoutingService } from './services/routing.service';
import { DispatchController } from './controllers/dispatch.controller';
import { OrderCoreModule } from '../orders/order-core.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { WarehousesModule } from '../warehouses/warehouses.module';
import { AssignmentEscalationModule } from '../assignment-escalation/assignment-escalation.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Company.name, schema: CompanySchema },
      { name: Truck.name, schema: TruckSchema },
      { name: Tank.name, schema: TankSchema },
    ]),
    OrderCoreModule,
    NotificationsModule,
    InvoicesModule,
    WarehousesModule,
    // spec 010: assignDriver schedules the acknowledgment-escalation window
    // once its own transaction commits (T030).
    AssignmentEscalationModule,
  ],
  controllers: [DispatchController],
  providers: [DispatchService, RoutingService],
  exports: [DispatchService, RoutingService],
})
export class DispatchModule {}
