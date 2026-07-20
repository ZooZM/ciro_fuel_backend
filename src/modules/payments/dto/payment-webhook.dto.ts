import { IsIn, IsISO8601, IsNumber, IsString } from 'class-validator';

export class PaymentWebhookDto {
  @IsString()
  transactionId!: string;

  @IsString()
  orderId!: string;

  @IsNumber()
  amount!: number;

  @IsIn(['SAR'])
  currency!: string;

  @IsString()
  status!: string;

  @IsISO8601()
  paidAt!: string;
}
