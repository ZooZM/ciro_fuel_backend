import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../users/schemas/user.schema';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { EtaService } from './eta.service';
import { RouteService } from './route.service';
import { PricingService } from './services/pricing.service';
import { TransportPricingModule } from './transport-pricing.module';
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
import { FilesModule } from '../files/files.module';
import { LitreBalancesModule } from '../litre-balances/litre-balances.module';
import { SupplierInvoicesService } from './services/supplier-invoices.service';
import { SupplierInvoiceExtractionPort } from './services/supplier-invoice-extraction.port';
import { NullSupplierInvoiceExtractor } from './services/null-supplier-invoice-extractor';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    OrderCoreModule,
    DispatchModule,
    PaymentsModule,
    // `PricingService` still derives the quote here; the transport rate lookup
    // it used to own now lives in a leaf module shared with `RoutingService`,
    // which is what asks the question after routing resolves the hauler.
    TransportPricingModule,
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
    FilesModule,
    LitreBalancesModule,
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    EtaService,
    RouteService,
    PricingService,
    VehicleVerificationService,
    SupplierInvoicesService,
    // T179/R8 — the null extractor is the default and, today, only binding for the port.
    { provide: SupplierInvoiceExtractionPort, useClass: NullSupplierInvoiceExtractor },
  ],
  exports: [OrdersService, PricingService],
})
export class OrdersModule {}
