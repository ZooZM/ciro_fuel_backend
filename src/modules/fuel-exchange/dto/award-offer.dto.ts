import { IsMongoId } from 'class-validator';

/** spec 016 T060 — the raiser names which proposal wins. */
export class AwardOfferDto {
  @IsMongoId()
  proposalId!: string;
}
