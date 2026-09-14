import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { PlatformOverviewService } from './platform-overview.service';
import { OrdersModule } from '../orders/orders.module';
import { OrderCoreModule } from '../orders/order-core.module';
import { CompaniesModule } from '../companies/companies.module';
import { StationsModule } from '../stations/stations.module';

/**
 * spec 017 (operator dashboard) T030 — the platform operator's own figures.
 *
 * Imports rather than re-declares every collection it reads: the order bucket
 * counts come from `OrdersService`, the company counts from `CompaniesService`
 * and the station count from `StationsService`, so this module owns exactly one
 * thing — the cross-company aggregation the other three have no reason to know
 * about. `OrderCoreModule` supplies the `Order` model itself for the two
 * aggregates that genuinely need it.
 */
@Module({
  imports: [OrderCoreModule, OrdersModule, CompaniesModule, StationsModule],
  controllers: [PlatformController],
  providers: [PlatformOverviewService],
  exports: [PlatformOverviewService],
})
export class PlatformModule {}
