import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LitreBalance, LitreBalanceSchema } from './schemas/litre-balance.schema';
import { LitreBalancesService } from './litre-balances.service';
import { LitreBalancesController } from './litre-balances.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: LitreBalance.name, schema: LitreBalanceSchema }])],
  controllers: [LitreBalancesController],
  providers: [LitreBalancesService],
  exports: [LitreBalancesService],
})
export class LitreBalancesModule {}
