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
import { CompaniesModule } from '../companies/companies.module';
import { TransportPricingModule } from '../orders/transport-pricing.module';
import { PaymentsModule } from '../payments/payments.module';
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
    CompaniesModule,
    // spec 010: assignDriver schedules the acknowledgment-escalation window
    // once its own transaction commits (T030).
    AssignmentEscalationModule,
    // The transport price is resolved AT routing now — the company that
    // performs the haul is the one that prices it — so `RoutingService` needs
    // the rate lookup. It is a leaf module precisely so this import is legal.
    TransportPricingModule,
    // For the payment-deadline job: the station owner settles the total routing
    // produced, so routing is what starts that clock.
    //
    // Newly safe, and safe only because of this change: `PaymentsModule` used
    // to import `DispatchModule` so settlement could resume routing. Routing
    // now PRECEDES payment, so that edge is gone and this one replaces it. The
    // graph stays one-directional; it simply points the other way.
    PaymentsModule,
  ],
  controllers: [DispatchController],
  providers: [DispatchService, RoutingService],
  exports: [DispatchService, RoutingService],
})
export class DispatchModule {}
