import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Company, CompanyDocument } from './schemas/company.schema';
import { CompanyStatus } from '../../common/enums/company-status.enum';
import { FuelType } from '../../common/enums/fuel-type.enum';

@Injectable()
export class CompaniesService {
  constructor(@InjectModel(Company.name) private readonly companyModel: Model<CompanyDocument>) {}

  async findById(id: string | Types.ObjectId): Promise<CompanyDocument> {
    const company = await this.companyModel.findById(id).exec();
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }

  async isActive(id: string | Types.ObjectId): Promise<boolean> {
    const company = await this.companyModel.findById(id).select('status').lean().exec();
    return company?.status === CompanyStatus.ACTIVE;
  }

  async getBasePrice(
    companyId: string | Types.ObjectId,
    fuelType: FuelType,
  ): Promise<number | undefined> {
    const company = await this.companyModel.findById(companyId).select('fuelPrices').lean().exec();
    return company?.fuelPrices.find((p) => p.fuelType === fuelType)?.basePricePerLiter;
  }

  create(data: Partial<Company>): Promise<CompanyDocument> {
    return this.companyModel.create(data);
  }

  findAll(): Promise<CompanyDocument[]> {
    return this.companyModel.find().exec();
  }

  async setStatus(id: string, status: CompanyStatus): Promise<CompanyDocument> {
    const company = await this.companyModel.findByIdAndUpdate(id, { status }, { new: true }).exec();
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }

  async setCommercialRegisterFile(id: string, fileId: Types.ObjectId): Promise<CompanyDocument> {
    const company = await this.companyModel
      .findByIdAndUpdate(id, { commercialRegisterFileId: fileId }, { new: true })
      .exec();
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }

  async setFuelPrices(
    id: string,
    fuelPrices: { fuelType: FuelType; basePricePerLiter: number }[],
  ): Promise<CompanyDocument> {
    const company = await this.companyModel
      .findByIdAndUpdate(id, { fuelPrices }, { new: true })
      .exec();
    if (!company) {
      throw new NotFoundException('Company not found');
    }
    return company;
  }
}
