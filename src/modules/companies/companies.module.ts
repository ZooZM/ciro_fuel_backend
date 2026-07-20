import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Company, CompanySchema } from './schemas/company.schema';
import { CompaniesService } from './companies.service';
import { CompaniesController } from './companies.controller';
import { UsersModule } from '../users/users.module';
import { FilesModule } from '../files/files.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Company.name, schema: CompanySchema }]),
    forwardRef(() => UsersModule),
    FilesModule,
  ],
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
