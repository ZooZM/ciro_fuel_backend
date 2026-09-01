import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Invoice, InvoiceSchema } from './schemas/invoice.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { InvoicesService } from './invoices.service';
import { InvoicesController } from './invoices.controller';

/**
 * Leaf module (mirrors `OrderCoreModule`'s shape): only the models it needs
 * directly, no imports of Orders/Payments/Dispatch. This lets both
 * OrdersModule (issuance at approval) and PaymentsModule (settlement on
 * webhook) — which already depend on each other in one direction — import
 * InvoicesModule without creating a cycle.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Invoice.name, schema: InvoiceSchema },
      { name: Order.name, schema: OrderSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
