import { IsBoolean } from 'class-validator';

/**
 * Whitelists `isFavourite` alone — the only field a CLIENT may write on
 * their own station (FR-036a/FR-037). The global `ValidationPipe` (server.ts,
 * `forbidNonWhitelisted: true`) rejects any other field with 400, which is
 * the enforcement mechanism for FR-036b's "no create/rename/delete" rule at
 * this endpoint: there is nothing else here to smuggle a rename through.
 */
export class SetFavouriteDto {
  @IsBoolean()
  isFavourite!: boolean;
}
