import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from './schemas/user.schema';
import { PhoneVerification, PhoneVerificationSchema } from './schemas/phone-verification.schema';
import {
  CreditLimitRequest,
  CreditLimitRequestSchema,
} from './schemas/credit-limit-request.schema';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { CreditLimitRequestsController } from './credit-limit-requests.controller';
import { PhoneVerificationService } from './services/phone-verification.service';
import { CreditLimitRequestsService } from './services/credit-limit-requests.service';
import { CompaniesModule } from '../companies/companies.module';
import { FilesModule } from '../files/files.module';
import { StationsModule } from '../stations/stations.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LitreBalancesModule } from '../litre-balances/litre-balances.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: PhoneVerification.name, schema: PhoneVerificationSchema },
      { name: CreditLimitRequest.name, schema: CreditLimitRequestSchema },
    ]),
    forwardRef(() => CompaniesModule),
    FilesModule,
    StationsModule,
    InvoicesModule,
    NotificationsModule,
    LitreBalancesModule,
  ],
  controllers: [UsersController, CreditLimitRequestsController],
  providers: [UsersService, PhoneVerificationService, CreditLimitRequestsService],
  exports: [UsersService],
})
export class UsersModule {}
