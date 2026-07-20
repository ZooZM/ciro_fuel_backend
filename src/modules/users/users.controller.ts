import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from './users.service';
import { FilesService } from '../files/files.service';
import { FilePurpose } from '../files/schemas/file.schema';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateTruckDto } from './dto/update-truck.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../common/interfaces/jwt-payload.interface';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';

@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly filesService: FilesService,
  ) {}

  @Roles(UserRole.COMPANY_ADMIN)
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateUserDto) {
    if (!user.companyId) {
      throw new BadRequestException('Acting user must belong to a company');
    }
    if (dto.role === UserRole.CLIENT && !dto.stationLocation) {
      throw new BadRequestException('stationLocation is required for CLIENT accounts');
    }
    if (dto.role === UserRole.DRIVER && !dto.truck) {
      throw new BadRequestException('truck is required for DRIVER accounts');
    }

    return this.usersService.create({
      companyId: user.companyId as never,
      role: dto.role,
      email: dto.email,
      password: dto.password,
      fullName: dto.fullName,
      phone: dto.phone,
      isActive: true,
      ...(dto.role === UserRole.CLIENT
        ? {
            stationLocation: {
              type: 'Point',
              coordinates: [dto.stationLocation!.longitude, dto.stationLocation!.latitude],
            } as never,
          }
        : {}),
      ...(dto.role === UserRole.DRIVER
        ? {
            isAvailable: true,
            isOnline: false,
            truck: dto.truck as never,
          }
        : {}),
    });
  }

  @Roles(UserRole.COMPANY_ADMIN, UserRole.SUPER_ADMIN)
  @Get()
  findAll(@Query('role') role?: UserRole, @Query('isActive') isActive?: string) {
    return this.usersService.findAll({
      role,
      isActive: isActive === undefined ? undefined : isActive === 'true',
    });
  }

  @Get(':id')
  async findOne(@CurrentUser() user: AuthenticatedUser, @Param('id', ObjectIdPipe) id: string) {
    if (
      user.role !== UserRole.COMPANY_ADMIN &&
      user.role !== UserRole.SUPER_ADMIN &&
      user.userId !== id
    ) {
      throw new ForbiddenException('May only view your own profile');
    }
    return this.usersService.findById(id);
  }

  /** role/companyId are immutable and never accepted here — UpdateUserDto whitelists only fullName/phone. */
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    if (
      user.role !== UserRole.COMPANY_ADMIN &&
      user.role !== UserRole.SUPER_ADMIN &&
      user.userId !== id
    ) {
      throw new ForbiddenException('May only update your own profile');
    }
    return this.usersService.update(id, dto);
  }

  @Roles(UserRole.COMPANY_ADMIN)
  @Patch(':id/activate')
  activate(@Param('id', ObjectIdPipe) id: string) {
    return this.usersService.setActive(id, true);
  }

  @Roles(UserRole.COMPANY_ADMIN)
  @Patch(':id/deactivate')
  deactivate(@Param('id', ObjectIdPipe) id: string) {
    // Deactivating a driver mid-delivery blocks NEW assignments only — their
    // activeOrderId (if any) is left untouched so the in-progress job completes.
    return this.usersService.setActive(id, false);
  }

  @Roles(UserRole.COMPANY_ADMIN)
  @Patch(':id/truck')
  updateTruck(@Param('id', ObjectIdPipe) id: string, @Body() dto: UpdateTruckDto) {
    return this.usersService.updateTruck(id, dto);
  }

  /** Self-service or admin-managed avatar upload — feeds a user's profilePictureFileId. */
  @Patch(':id/profile-picture')
  @UseInterceptors(FileInterceptor('file'))
  async uploadProfilePicture(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ObjectIdPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (
      user.role !== UserRole.COMPANY_ADMIN &&
      user.role !== UserRole.SUPER_ADMIN &&
      user.userId !== id
    ) {
      throw new ForbiddenException('May only update your own profile picture');
    }
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!user.companyId) {
      throw new BadRequestException('Only company-scoped users may upload files here');
    }
    const fileRecord = await this.filesService.recordUpload({
      companyId: user.companyId,
      ownerUserId: id,
      purpose: FilePurpose.PROFILE_PICTURE,
      storagePath: file.path,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      originalName: file.originalname,
    });
    return this.usersService.update(id, { profilePictureFileId: fileRecord._id as never });
  }
}
