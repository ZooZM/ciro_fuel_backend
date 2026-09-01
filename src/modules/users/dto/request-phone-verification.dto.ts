import { Matches } from 'class-validator';
import { E164_PATTERN } from '../../../common/constants/phone';

export class RequestPhoneVerificationDto {
  @Matches(E164_PATTERN, { message: 'newPhone must be in E.164 format' })
  newPhone!: string;
}
