import { Matches } from 'class-validator';
import { E164_PATTERN } from '../../../common/constants/phone';

export class RequestPasswordResetDto {
  @Matches(E164_PATTERN, { message: 'phone must be in E.164 format' })
  phone!: string;
}
