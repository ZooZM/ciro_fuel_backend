import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../users/schemas/user.schema';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { EtaService } from './eta.service';
import { RouteService } from './route.service';
import { PricingService } from './services/pricing.service';
import { OrderCoreModule } from './order-core.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { PaymentsModule } from '../payments/payments.module';
import { CompaniesModule } from '../companies/companies.module';
import { UsersModule } from '../users/users.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { StationsModule } from '../stations/stations.module';
import { RatingsModule } from '../ratings/ratings.module';
import { TrucksModule } from '../trucks/trucks.module';
import { TanksModule } from '../tanks/tanks.module';
import { WarehousesModule } from '../warehouses/warehouses.module';
import { VehicleVerificationService } from './services/vehicle-verification.service';
import { StopDetectionModule } from '../stop-detection/stop-detection.module';
import { AssignmentEscalationModule } from '../assignment-escalation/assignment-escalation.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    OrderCoreModule,
    DispatchModule,
    PaymentsModule,
    CompaniesModule,
    UsersModule,
    NotificationsModule,
    InvoicesModule,
    StationsModule,
    RatingsModule,
    TrucksModule,
    TanksModule,
    WarehousesModule,
    // spec 010: OrdersService.cancel needs to cancel a pending escalation
    // (T031), and OrdersController's new acknowledge-assignment endpoint
    // needs it too (T032) — imported directly rather than relying on
    // DispatchModule to re-export it, since AssignmentEscalationModule
    // isn't global.
    AssignmentEscalationModule,
    // spec 011: the driver's declare/answer endpoints delegate to
    // StopDetectionService, which owns the one-open-stop invariant the
    // sweep also enforces — the two paths must share it, not restate it.
    StopDetectionModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, EtaService, RouteService, PricingService, VehicleVerificationService],
  exports: [OrdersService, PricingService],
})
export class OrdersModule {}
