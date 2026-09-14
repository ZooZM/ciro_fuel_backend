import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { PlatformAccountService } from './platform-account.service';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { RecordCashbackPayoutDto } from './dto/record-cashback-payout.dto';
import { FilesService } from '../files/files.service';
import { FilePurpose } from '../files/schemas/file.schema';
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from '../files/files.constants';
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
  constructor(
    private readonly platformAccountService: PlatformAccountService,
    private readonly filesService: FilesService,
  ) {}

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
  async confirmPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
  ) {
    const movement = await this.platformAccountService.confirmPayment(id, user.userId);
    return this.platformAccountService.toMovementView(movement);
  }

  /**
   * spec 017 (operator dashboard) T143/FR-065 — what the platform currently
   * owes this fuel company in cashback.
   *
   * Computed live from confirmed movements of TWO kinds, never stored — see
   * `getCashbackOwed`, and note that the per-kind `getConfirmedBalance` cannot
   * answer this (research R11).
   */
  @Roles(UserRole.SUPER_ADMIN)
  @Get('cashback/:companyId/owed')
  async getCashbackOwed(@Param('companyId', ObjectIdPipe) companyId: string) {
    return {
      companyId,
      owed: await this.platformAccountService.getCashbackOwed(companyId),
      currency: DEFAULT_CURRENCY,
    };
  }

  /**
   * spec 017 T143/FR-066/FR-072/FR-073 — the operator records a cashback payout.
   *
   * `SUPER_ADMIN` only, and the restriction is substantive rather than
   * conventional: a company must never be able to record money as having been
   * paid TO it. That is the one assertion on this route nobody can be talked
   * out of.
   *
   * **No payment provider is integrated** (FR-073). This route records that
   * money moved elsewhere; it does not move any.
   */
  @Roles(UserRole.SUPER_ADMIN)
  @Post('cashback/:companyId/payouts')
  @UseInterceptors(
    FileInterceptor('evidence', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          cb(new BadRequestException(`Unsupported file type: ${file.mimetype}`), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async recordCashbackPayout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ObjectIdPipe) companyId: string,
    @UploadedFile() evidence: Express.Multer.File | undefined,
    @Body() dto: RecordCashbackPayoutDto,
  ) {
    // Stored BEFORE the transaction, like `companies.controller.ts`'s
    // commercial register is stored after one: object storage is outside any
    // Mongo transaction either way, and here the file's id has to be on the
    // movement the transaction writes. A payout that is then refused leaves an
    // unreferenced blob, which is the cheaper of the two failures — the
    // alternative is a committed movement whose evidence failed to store.
    let documentFileId = dto.documentFileId;
    if (evidence) {
      const fileRecord = await this.filesService.store({
        companyId,
        purpose: FilePurpose.PAYMENT_EVIDENCE,
        buffer: evidence.buffer,
        mimeType: evidence.mimetype,
        originalName: evidence.originalname,
      });
      documentFileId = String(fileRecord._id);
    }

    const movement = await this.platformAccountService.recordCashbackPayout(
      companyId,
      {
        amount: dto.amount,
        method: dto.method,
        reference: dto.reference,
        documentFileId,
      },
      DEFAULT_CURRENCY,
      user.userId,
    );
    return this.platformAccountService.toMovementView(movement);
  }
}
