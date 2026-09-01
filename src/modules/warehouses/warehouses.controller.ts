import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { WarehousesService } from './warehouses.service';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';
import { BulkLoadWarehousesDto } from './dto/bulk-load-warehouses.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { ObjectIdPipe } from '../../common/pipes/object-id.pipe';

/**
 * `Warehouse` carries neither scoping plugin (research R1) — read is open to
 * every authenticated role (no `@Roles` on the GETs), write is SUPER_ADMIN
 * only (FR-035c), exactly as `CompaniesController` restricts company
 * creation.
 */
@Controller({ path: 'warehouses', version: '1' })
export class WarehousesController {
  constructor(private readonly warehousesService: WarehousesService) {}

  @Get()
  async findAll() {
    const items = await this.warehousesService.findAll();
    return { items };
  }

  @Get(':id')
  findOne(@Param('id', ObjectIdPipe) id: string) {
    return this.warehousesService.findById(id);
  }

  @Roles(UserRole.SUPER_ADMIN)
  @Post()
  create(@Body() dto: CreateWarehouseDto) {
    return this.warehousesService.create(dto);
  }

  @Roles(UserRole.SUPER_ADMIN)
  @Post('bulk')
  bulkLoad(@Body() dto: BulkLoadWarehousesDto) {
    return this.warehousesService.bulkLoad(dto.warehouses);
  }

  @Roles(UserRole.SUPER_ADMIN)
  @Patch(':id')
  update(@Param('id', ObjectIdPipe) id: string, @Body() dto: UpdateWarehouseDto) {
    return this.warehousesService.update(id, dto);
  }

  @Roles(UserRole.SUPER_ADMIN)
  @Patch(':id/withdraw')
  withdraw(@Param('id', ObjectIdPipe) id: string) {
    return this.warehousesService.withdraw(id);
  }
}
