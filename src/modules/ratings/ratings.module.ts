import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DeliveryRating, DeliveryRatingSchema } from './schemas/delivery-rating.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { RatingsService } from './ratings.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DeliveryRating.name, schema: DeliveryRatingSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  providers: [RatingsService],
  exports: [RatingsService],
})
export class RatingsModule {}
