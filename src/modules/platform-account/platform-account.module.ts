import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccountMovement, AccountMovementSchema } from './schemas/account-movement.schema';
import { PlatformAccountService } from './platform-account.service';
import { PlatformAccountController } from './platform-account.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: AccountMovement.name, schema: AccountMovementSchema }])],
  controllers: [PlatformAccountController],
  providers: [PlatformAccountService],
  exports: [PlatformAccountService],
})
export class PlatformAccountModule {}
