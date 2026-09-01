import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from './schemas/user.schema';
import { PhoneVerification, PhoneVerificationSchema } from './schemas/phone-verification.schema';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { PhoneVerificationService } from './services/phone-verification.service';
import { CompaniesModule } from '../companies/companies.module';
import { FilesModule } from '../files/files.module';
import { StationsModule } from '../stations/stations.module';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: PhoneVerification.name, schema: PhoneVerificationSchema },
    ]),
    forwardRef(() => CompaniesModule),
    FilesModule,
    StationsModule,
    InvoicesModule,
  ],
  controllers: [UsersController],
  providers: [UsersService, PhoneVerificationService],
  exports: [UsersService],
})
export class UsersModule {}
