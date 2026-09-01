import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Station, StationSchema } from './schemas/station.schema';
import { StationsService } from './stations.service';
import { StationsController } from './stations.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: Station.name, schema: StationSchema }])],
  controllers: [StationsController],
  providers: [StationsService],
  exports: [StationsService, MongooseModule],
})
export class StationsModule {}
