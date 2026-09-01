import { Controller, Get } from '@nestjs/common';
import { RegionsService } from './regions.service';
import { Public } from '../../common/decorators/public.decorator';

/** Reference data, not tenant data — every authenticated and unauthenticated
 * caller sees the same fixed list (spec 004 FR-010), so this is public and
 * never routes through tenant isolation. */
@Controller({ path: 'regions', version: '1' })
export class RegionsController {
  constructor(private readonly regionsService: RegionsService) {}

  @Public()
  @Get()
  list() {
    return this.regionsService.list();
  }
}
