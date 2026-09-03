import { Body, Controller, ForbiddenException, Get, Param, Post, Query } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { SettleInvoiceDto } from './dto/settle-invoice.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { PaymentMethod } from '../../common/enums/payment-method.enum';
import { InvoiceState } from '../../common/enums/invoice-state.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';

@Controller({ path: 'invoices', version: '1' })
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.TRANSPORT_COMPANY_ADMIN, UserRole.CLIENT, UserRole.SUPER_ADMIN)
  @Get()
  findMine(
    @Query('method') method?: PaymentMethod,
    @Query('state') state?: InvoiceState,
    @Query('cursor') cursor?: string,
    @Query('fuelCompanyId') fuelCompanyId?: string,
  ) {
    return this.invoicesService.findForUser({
      method: method || undefined,
      state: state || undefined,
      cursor: cursor || undefined,
      fuelCompanyId: fuelCompanyId || undefined,
    });
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.TRANSPORT_COMPANY_ADMIN, UserRole.CLIENT)
  @Get(':id')
  findOne(@Param('id', ObjectIdPipe) id: string) {
    return this.invoicesService.findById(id);
  }

  /**
   * Manual settlement — for the two methods the platform never confirms via
   * a payment gateway webhook. DIRECT invoices are settled exclusively by
   * the signed Sadad/Mada webhook (`payments.service.ts`) and are refused
   * here (spec 004 FR-020a/FR-022):
   * - DEFERRED: settleable only by the Transportation Company it's payable
   *   to (FR-022) — the multi-party plugin already 404s a DEFERRED invoice
   *   not yet routed to, or routed to a different, transporter, before this
   *   role check even runs.
   * - CREDIT: settled by the Fuel Company, recording the client's
   *   off-platform repayment against their limit (FR-023/FR-024).
   */
  @Roles(UserRole.TRANSPORT_COMPANY_ADMIN, UserRole.FUEL_COMPANY_ADMIN)
  @Post(':id/settle')
  async settle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: SettleInvoiceDto,
  ) {
    const invoice = await this.invoicesService.findById(id);
    if (invoice.method === PaymentMethod.DIRECT) {
      throw new ForbiddenException('Direct invoices are settled only by the payment webhook');
    }
    if (
      invoice.method === PaymentMethod.DEFERRED &&
      user.role !== UserRole.TRANSPORT_COMPANY_ADMIN
    ) {
      throw new ForbiddenException('Only the Transportation Company may settle a deferred invoice');
    }
    if (invoice.method === PaymentMethod.CREDIT && user.role !== UserRole.FUEL_COMPANY_ADMIN) {
      throw new ForbiddenException('Only the Fuel Company may settle a credit invoice');
    }
    return this.invoicesService.settleById(id, dto.paymentReference);
  }
}
