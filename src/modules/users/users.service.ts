import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './schemas/user.schema';
import { UserRole } from '../../common/enums/user-role.enum';
import { CompaniesService } from '../companies/companies.service';

const SALT_ROUNDS = 12;

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly companiesService: CompaniesService,
  ) {}

  async findByEmailForAuth(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() }).select('+passwordHash').exec();
  }

  async findById(id: string | Types.ObjectId): Promise<UserDocument> {
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /**
   * Re-validated on every authenticated request (not just at login) so a
   * deactivated account or suspended company loses access immediately,
   * rather than waiting for the JWT to expire.
   */
  async validateActiveSession(userId: string): Promise<UserDocument> {
    const user = await this.userModel.findById(userId).exec();
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.role !== UserRole.SUPER_ADMIN && user.companyId) {
      const companyActive = await this.companiesService.isActive(user.companyId);
      if (!companyActive) {
        throw new UnauthorizedException('Invalid credentials');
      }
    }
    return user;
  }

  static async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, SALT_ROUNDS);
  }

  static comparePassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  create(data: Partial<User> & { password: string }): Promise<UserDocument> {
    const { password, ...rest } = data;
    return UsersService.hashPassword(password).then((passwordHash) =>
      this.userModel.create({ ...rest, passwordHash }),
    );
  }

  async countByRole(companyId: string, role: UserRole): Promise<number> {
    return this.userModel.countDocuments({ companyId, role }).exec();
  }

  findAll(filter: { role?: UserRole; isActive?: boolean }): Promise<UserDocument[]> {
    return this.userModel.find(filter).exec();
  }

  async setActive(id: string, isActive: boolean): Promise<UserDocument> {
    const user = await this.userModel.findByIdAndUpdate(id, { isActive }, { new: true }).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async updateTruck(
    id: string,
    truck: { plateNumber: string; maxCapacityLiters: number; fuelTypes: string[]; model?: string },
  ): Promise<UserDocument> {
    const user = await this.userModel.findByIdAndUpdate(id, { truck }, { new: true }).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async update(id: string, data: Partial<User>): Promise<UserDocument> {
    const user = await this.userModel.findByIdAndUpdate(id, data, { new: true }).exec();
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }
}
