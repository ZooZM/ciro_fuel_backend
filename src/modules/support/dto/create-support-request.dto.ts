import { IsEnum, IsMongoId, IsOptional, IsString, Length } from 'class-validator';
import { SupportTopic } from '../../../common/enums/support-topic.enum';

export class CreateSupportRequestDto {
  @IsEnum(SupportTopic)
  topic!: SupportTopic;

  @IsString()
  @Length(1, 2000)
  message!: string;

  @IsOptional()
  @IsMongoId()
  orderId?: string;
}
