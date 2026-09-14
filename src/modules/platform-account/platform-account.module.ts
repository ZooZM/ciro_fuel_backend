import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccountMovement, AccountMovementSchema } from './schemas/account-movement.schema';
import { PlatformAccountService } from './platform-account.service';
import { PlatformAccountController } from './platform-account.controller';
import { FilesModule } from '../files/files.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: AccountMovement.name, schema: AccountMovementSchema }]),
    // spec 017 T143 — a cashback payout may carry an evidence document, stored
    // through the existing FilesService like every other upload on the platform.
    FilesModule,
  ],
  controllers: [PlatformAccountController],
  providers: [PlatformAccountService],
  exports: [PlatformAccountService],
})
export class PlatformAccountModule {}
