import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ExchangeRequest, ExchangeRequestSchema } from './schemas/exchange-request.schema';
import { ExchangeOffer, ExchangeOfferSchema } from './schemas/exchange-offer.schema';
import { ExchangeProposal, ExchangeProposalSchema } from './schemas/exchange-proposal.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { FuelExchangeService } from './fuel-exchange.service';
import { FuelExchangeController } from './fuel-exchange.controller';
import { CompaniesModule } from '../companies/companies.module';
import { NotificationsModule } from '../notifications/notifications.module';

// spec 014 Phase 15: Part A (T217's gate) registered only the ExchangeRequest schema, so
// the isolation e2e suite could prove the mechanism against the real collection before
// any service/controller existed. spec 016 Slice 0 repeats that discipline for
// ExchangeOffer/ExchangeProposal (T024's gate) — this module registers both schemas
// (plus User, for the cross-tenant recipient-admin lookup — same direct-injection
// pattern `ratings.module.ts` uses) alongside the retained, read-only ExchangeRequest.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ExchangeRequest.name, schema: ExchangeRequestSchema },
      { name: ExchangeOffer.name, schema: ExchangeOfferSchema },
      { name: ExchangeProposal.name, schema: ExchangeProposalSchema },
      { name: User.name, schema: UserSchema },
    ]),
    CompaniesModule,
    NotificationsModule,
  ],
  controllers: [FuelExchangeController],
  providers: [FuelExchangeService],
})
export class FuelExchangeModule {}
