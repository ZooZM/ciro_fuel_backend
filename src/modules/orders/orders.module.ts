import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../users/schemas/user.schema';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { OrderCoreModule } from './order-core.module';
import { DispatchModule } from '../dispatch/dispatch.module';
import { PaymentsModule } from '../payments/payments.module';
import { CompaniesModule } from '../companies/companies.module';
import { UsersModule } from '../users/users.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    OrderCoreModule,
    DispatchModule,
    PaymentsModule,
    CompaniesModule,
    UsersModule,
    NotificationsModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
