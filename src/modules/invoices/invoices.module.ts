import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Invoice, InvoiceSchema } from './schemas/invoice.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { InvoicesService } from './invoices.service';
import { InvoicesController } from './invoices.controller';
import { BillingModule } from '../billing/billing.module';

/**
 * Leaf module (mirrors `OrderCoreModule`'s shape): only the models it needs
 * directly, no imports of Orders/Payments/Dispatch. This lets both
 * OrdersModule (issuance at approval) and PaymentsModule (settlement on
 * webhook) — which already depend on each other in one direction — import
 * InvoicesModule without creating a cycle.
 *
 * spec 013 T142/T144/T149: `BillingModule` is added here (not to Orders/Payments
 * directly) because commission/cashback accrual and reversal all hook into
 * `InvoicesService`'s own methods (`issueInvoice`/settlement/`voidInvoice`) — the leaf
 * property survives since `BillingModule` itself depends on nothing but `Company`'s
 * schema and its own new `PlatformAccountModule`, neither of which touches
 * Orders/Payments/Dispatch.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Invoice.name, schema: InvoiceSchema },
      { name: Order.name, schema: OrderSchema },
      { name: User.name, schema: UserSchema },
    ]),
    BillingModule,
  ],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
