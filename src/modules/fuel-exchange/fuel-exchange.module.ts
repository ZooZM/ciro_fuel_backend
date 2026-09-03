import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ExchangeRequest, ExchangeRequestSchema } from './schemas/exchange-request.schema';
import { FuelExchangeService } from './fuel-exchange.service';
import { FuelExchangeController } from './fuel-exchange.controller';
import { CompaniesModule } from '../companies/companies.module';

// spec 013 Phase 15: Part A (T217's gate) registered only the schema, so
// `test/e2e/party-set-isolation.e2e-spec.ts` could prove the isolation mechanism against
// the real collection through the full app stack before any service/controller existed.
// Part B adds the service/controller here, in the same module.
@Module({
  imports: [
    MongooseModule.forFeature([{ name: ExchangeRequest.name, schema: ExchangeRequestSchema }]),
    CompaniesModule,
  ],
  controllers: [FuelExchangeController],
  providers: [FuelExchangeService],
})
export class FuelExchangeModule {}
