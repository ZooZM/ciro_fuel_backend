import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { PaymentsService, WebhookResult } from './payments.service';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';
import { Public } from '../../common/decorators/public.decorator';
import { PaymentGateway } from './schemas/payment-event.schema';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';

const VALID_GATEWAYS = new Set(Object.values(PaymentGateway).map((g) => g.toLowerCase()));

@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Roles(UserRole.CLIENT)
  @Get()
  findMine(@CurrentUser() user: AuthenticatedUser, @Query('cursor') cursor?: string) {
    return this.paymentsService.findForClient(user.userId, cursor || undefined);
  }

  @Public()
  @Post('webhook/:gateway')
  async webhook(
    @Param('gateway') gatewayParam: string,
    @Body() dto: PaymentWebhookDto,
    @Headers('x-signature') signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<WebhookResult> {
    const normalizedGateway = gatewayParam.toUpperCase();
    if (!VALID_GATEWAYS.has(gatewayParam.toLowerCase())) {
      throw new BadRequestException(`Unsupported payment gateway: ${gatewayParam}`);
    }
    if (!req.rawBody) {
      throw new BadRequestException('Raw request body unavailable for signature verification');
    }

    return this.paymentsService.handleWebhook(
      normalizedGateway as PaymentGateway,
      dto,
      req.rawBody,
      signature,
    );
  }
}
