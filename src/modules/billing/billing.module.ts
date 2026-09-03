import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CommissionTerm, CommissionTermSchema } from './schemas/commission-term.schema';
import { CashbackProgramme, CashbackProgrammeSchema } from './schemas/cashback-programme.schema';
import { Company, CompanySchema } from '../companies/schemas/company.schema';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { PlatformAccountModule } from '../platform-account/platform-account.module';

// spec 013 T136 — its own module, not an extension of `orders`/`invoices`, so this
// domain can be split into its own feature later without unpicking a shared module (plan
// Structure Decision). `Company`'s schema is registered here read-only (`resolveCeiling`
// only ever selects `commissionCeiling`) rather than importing `CompaniesModule`, to
// avoid coupling two otherwise-independent modules over one field.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CommissionTerm.name, schema: CommissionTermSchema },
      { name: CashbackProgramme.name, schema: CashbackProgrammeSchema },
      { name: Company.name, schema: CompanySchema },
    ]),
    PlatformAccountModule,
  ],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
