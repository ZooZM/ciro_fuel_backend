import { IsBoolean } from 'class-validator';

// spec 013 T224/FR-080 — the recipient's own response only; the raiser uses the
// separate withdraw endpoint (T225), never this one.
export class RespondExchangeRequestDto {
  @IsBoolean()
  accept!: boolean;
}
