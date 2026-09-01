import { Body, Controller, Post } from '@nestjs/common';
import { GeocodingService } from './geocoding.service';
import { ReverseGeocodeDto } from './dto/reverse-geocode.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';

/**
 * Used only at client registration (spec 004 US3) — the Fuel Company admin
 * drops a pin and gets a suggested address to edit before saving. Never
 * called on an order or company read path (FR-012).
 */
@Controller({ path: 'geocoding', version: '1' })
export class GeocodingController {
  constructor(private readonly geocodingService: GeocodingService) {}

  @Roles(UserRole.FUEL_COMPANY_ADMIN)
  @Post('reverse')
  reverse(@Body() dto: ReverseGeocodeDto) {
    return this.geocodingService.reverseGeocode(dto.latitude, dto.longitude);
  }
}
