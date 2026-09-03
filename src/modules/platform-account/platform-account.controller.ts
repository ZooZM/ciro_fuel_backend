import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { PlatformAccountService } from './platform-account.service';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AccountMovementKind } from '../../common/enums/account-movement-kind.enum';
import { AccountMovementState } from '../../common/enums/account-movement-state.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';
import { DEFAULT_CURRENCY } from '../../common/constants/money.constants';

// spec 013 Phase 13 (US10) — a company's ledger with the platform and the manual,
// evidence-carrying, operator-confirmed settlement of it. No payment provider is
// integrated anywhere here (FR-066a): the platform displays details to pay elsewhere and
// records what the payer reports.
@Controller({ path: 'platform-account', version: '1' })
export class PlatformAccountController {
  constructor(private readonly platformAccountService: PlatformAccountService) {}

  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.SUPER_ADMIN)
  @Get('movements')
  findMovements(
    @Query('kind') kind?: AccountMovementKind,
    @Query('state') state?: AccountMovementState,
    @Query('cursor') cursor?: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.platformAccountService.listMovements({
      kind: kind || undefined,
      state: state || undefined,
      cursor: cursor || undefined,
      companyId: companyId || undefined,
    });
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Post('payments')
  recordPayment(@CurrentUser() user: AuthenticatedUser, @Body() dto: RecordPaymentDto) {
    return this.platformAccountService.recordPayment(
      user.companyId!,
      {
        amount: dto.amount,
        method: dto.method,
        reference: dto.reference,
        documentFileId: dto.documentFileId,
      },
      DEFAULT_CURRENCY,
    );
  }

  @Roles(UserRole.SUPER_ADMIN)
  @Patch('payments/:id/confirm')
  confirmPayment(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    return this.platformAccountService.confirmPayment(id, user.userId);
  }
}
