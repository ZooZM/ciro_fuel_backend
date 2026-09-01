import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Tank, TankSchema } from './schemas/tank.schema';
import { TanksService } from './tanks.service';
import { TanksController } from './tanks.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: Tank.name, schema: TankSchema }])],
  controllers: [TanksController],
  providers: [TanksService],
  exports: [TanksService, MongooseModule],
})
export class TanksModule {}
