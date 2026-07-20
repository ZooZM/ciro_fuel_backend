import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { Types } from 'mongoose';

@Injectable()
export class ObjectIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException(`Invalid identifier: ${value}`);
    }
    return value;
  }
}
