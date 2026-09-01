import { IsString, Length } from 'class-validator';

export class ConfirmPhoneVerificationDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}
