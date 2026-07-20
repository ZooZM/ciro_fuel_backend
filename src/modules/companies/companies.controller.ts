import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { CompaniesService } from './companies.service';
import { UsersService } from '../users/users.service';
import { FilesService } from '../files/files.service';
import { FilePurpose } from '../files/schemas/file.schema';
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from '../files/files.constants';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyStatusDto } from './dto/update-company-status.dto';
import { SetFuelPricesDto } from './dto/set-fuel-prices.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { CompanyStatus } from '../../common/enums/company-status.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';

@Controller({ path: 'companies', version: '1' })
export class CompaniesController {
  constructor(
    private readonly companiesService: CompaniesService,
    private readonly usersService: UsersService,
    private readonly filesService: FilesService,
  ) {}

  @Roles(UserRole.SUPER_ADMIN)
  @Post()
  @UseInterceptors(
    FileInterceptor('commercialRegister', {
      storage: memoryStorage(), // company doesn't exist yet — no companyId to key a disk path on
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          cb(new BadRequestException(`Unsupported file type: ${file.mimetype}`), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async create(
    @UploadedFile() commercialRegister: Express.Multer.File,
    @Body() dto: CreateCompanyDto,
  ) {
    if (!commercialRegister) {
      throw new BadRequestException('commercialRegister file is required');
    }

    const company = await this.companiesService.create({
      name: dto.name,
      contactEmail: dto.contactEmail,
      contactPhone: dto.contactPhone,
      status: CompanyStatus.ACTIVE,
      fuelPrices: [],
    });

    const fileRecord = await this.filesService.writeBufferAndRecord({
      companyId: company._id as never,
      purpose: FilePurpose.COMMERCIAL_REGISTER,
      buffer: commercialRegister.buffer,
      mimeType: commercialRegister.mimetype,
      originalName: commercialRegister.originalname,
    });
    await this.companiesService.setCommercialRegisterFile(
      String(company._id),
      fileRecord._id as never,
    );

    const admin = await this.usersService.create({
      companyId: company._id as never,
      role: UserRole.COMPANY_ADMIN,
      email: dto.adminEmail,
      password: dto.adminPassword,
      fullName: dto.adminFullName,
      phone: dto.adminPhone,
      isActive: true,
    });

    return {
      company: await this.companiesService.findById(String(company._id)),
      admin: { id: admin._id, email: admin.email },
    };
  }

  @Roles(UserRole.SUPER_ADMIN)
  @Get()
  findAll() {
    return this.companiesService.findAll();
  }

  @Get(':id')
  async findOne(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    this.assertCompanyAccess(user, id);
    return this.companiesService.findById(id);
  }

  @Roles(UserRole.SUPER_ADMIN)
  @Patch(':id/status')
  setStatus(@Param('id', ObjectIdPipe) id: string, @Body() dto: UpdateCompanyStatusDto) {
    return this.companiesService.setStatus(id, dto.status);
  }

  @Get(':id/fuel-prices')
  async getFuelPrices(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
  ) {
    this.assertCompanyAccess(user, id);
    const company = await this.companiesService.findById(id);
    return company.fuelPrices;
  }

  @Roles(UserRole.COMPANY_ADMIN)
  @Put(':id/fuel-prices')
  async setFuelPrices(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: SetFuelPricesDto,
  ) {
    this.assertCompanyAccess(user, id);
    return this.companiesService.setFuelPrices(id, dto.prices);
  }

  /** Company is the tenant root (not plugin-scoped) — ownership is checked explicitly (FR-002 spirit). */
  private assertCompanyAccess(user: AuthenticatedUser, companyId: string): void {
    if (user.role === UserRole.SUPER_ADMIN) return;
    if (user.companyId === companyId) return;
    throw new NotFoundException('Company not found');
  }
}
