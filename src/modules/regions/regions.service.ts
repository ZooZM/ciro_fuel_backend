import { Injectable } from '@nestjs/common';
import { GOVERNORATES, REGIONS } from './regions.constants';

@Injectable()
export class RegionsService {
  /** The 13 regions with their governorates nested — what the client station
   * form's region → governorate picker consumes directly. */
  list() {
    return REGIONS;
  }

  /** Flat governorate list, each carrying its parent region code — useful for
   * a lookup table without walking the nested structure. */
  listGovernorates() {
    return GOVERNORATES;
  }
}
