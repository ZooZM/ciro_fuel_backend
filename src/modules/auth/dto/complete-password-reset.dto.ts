import { IsString, MinLength } from 'class-validator';

export class CompletePasswordResetDto {
  @IsString()
  resetToken!: string;

  // The platform's existing password rule (create-user.dto.ts) — FR-026
  // reuses it rather than defining a stricter one for recovery.
  @IsString()
  @MinLength(8)
  newPassword!: string;
}
