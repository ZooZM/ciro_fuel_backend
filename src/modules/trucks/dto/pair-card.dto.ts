import { IsString, MinLength } from 'class-validator';

/** The raw identifier captured by the transporter's desk-mounted 13.56MHz reader (FR-004). */
export class PairCardDto {
  @IsString()
  @MinLength(1)
  nfcCardUid!: string;
}
