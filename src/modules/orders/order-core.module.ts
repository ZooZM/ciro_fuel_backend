import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from './schemas/order.schema';
import { OrderStateService } from './services/order-state.service';
import { OtpService } from './services/otp.service';

/**
 * Leaf module: OrderStateService and OtpService only need the Order model
 * (Redis is @Global()). Kept separate from the full OrdersModule so
 * DispatchModule and PaymentsModule can depend on just the state machine +
 * OTP logic without a circular import back through OrdersModule (which
 * itself depends on DispatchModule to trigger dispatch after approval).
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: Order.name, schema: OrderSchema }])],
  providers: [OrderStateService, OtpService],
  exports: [OrderStateService, OtpService, MongooseModule],
})
export class OrderCoreModule {}
