import { Module } from '@nestjs/common';
import { TransportPricingService } from './services/transport-pricing.service';
import { CompaniesModule } from '../companies/companies.module';
import { WarehousesModule } from '../warehouses/warehouses.module';

/**
 * Leaf module for the transport price, kept out of `OrdersModule` so
 * `DispatchModule` can reach it.
 *
 * `RoutingService` is what now asks what the haul costs — the delivery leg is
 * priced by the company that performs it, and routing is where that company is
 * chosen. `RoutingService` lives in `DispatchModule`, which deliberately cannot
 * import `OrdersModule` (`OrdersModule` imports IT — see `OrderCoreModule`'s
 * note on the same cycle). Its only dependencies are `CompaniesService` and
 * `WarehousesService`, neither of which reaches back here, so it sits safely
 * below both.
 */
@Module({
  imports: [CompaniesModule, WarehousesModule],
  providers: [TransportPricingService],
  exports: [TransportPricingService],
})
export class TransportPricingModule {}
