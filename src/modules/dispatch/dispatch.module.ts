import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../users/schemas/user.schema';
import { DispatchService } from './services/dispatch.service';
import { DispatchController } from './controllers/dispatch.controller';
import { OrderCoreModule } from '../orders/order-core.module';
import { PaymentsModule } from '../payments/payments.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    OrderCoreModule,
    PaymentsModule,
    NotificationsModule,
  ],
  controllers: [DispatchController],
  providers: [DispatchService],
  exports: [DispatchService],
})
export class DispatchModule {}
