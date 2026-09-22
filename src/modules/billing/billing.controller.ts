import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';
import { BillingService } from './billing.service';
import { SetCommissionTermDto } from './dto/set-commission-term.dto';
import { SetCashbackProgrammeDto } from './dto/set-cashback-programme.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';

@Controller({ path: 'billing', version: '1' })
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  // FR-055/FR-056 — read by both the operator and any fuel company (read-only for the
  // latter, enforced here by omitting FUEL_COMPANY_ADMIN from the PUT below, not by a
  // field-level flag).
  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.SUPER_ADMIN)
  @Get('commission-terms/current')
  getCurrentCommissionTerm() {
    return this.billingService.getCurrentCommissionTerm();
  }

  // T132/FR-058 — no update route exists; this always inserts a new record.
  @Roles(UserRole.SUPER_ADMIN)
  @Put('commission-terms')
  setCommissionTerm(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetCommissionTermDto) {
    return this.billingService.setCommissionTerm(dto.basis, dto.rate, user.userId);
  }

  @Roles(UserRole.FUEL_COMPANY_ADMIN, UserRole.SUPER_ADMIN)
  @Get('cashback-programme/current')
  getCurrentCashbackProgramme() {
    return this.billingService.getCurrentCashbackProgramme();
  }

  @Roles(UserRole.SUPER_ADMIN)
  @Put('cashback-programme')
  setCashbackProgramme(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetCashbackProgrammeDto,
  ) {
    return this.billingService.setCashbackProgramme(dto, user.userId);
  }

  // T145/FR-061/FR-062c — `user.companyId` is the caller's own; no `:id` route exists for
  // this because a Fuel Company only ever reads its own balances, never another's.
  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Get('balances/me')
  getMyBalances(@CurrentUser() user: AuthenticatedUser) {
    return this.billingService.getBalancesForCompany(user.companyId!);
  }

  /** spec 013 T238/FR-089 (US13) — the operator's view of ONE company's balances, for
   * the fuel company detail screen's "figures match what that company's own
   * administrator sees" independent test (quickstart 4.3). Registered after `balances/me`
   * so `me` is never swallowed by `:companyId`. */
  @Roles(UserRole.SUPER_ADMIN)
  @Get('balances/:companyId')
  getCompanyBalances(@Param('companyId', ObjectIdPipe) companyId: string) {
    return this.billingService.getBalancesForCompany(companyId);
  }
}
