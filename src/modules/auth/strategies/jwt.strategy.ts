import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import { JwtPayload, AuthenticatedUser } from '../../../common/interfaces/jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.secret')!,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    // Re-checks isActive + company status, and (spec 006) that this
    // token's session hasn't been revoked — see UsersService docstring.
    const { user, parentFuelCompanyId } =
      await this.usersService.validateActiveSessionWithScoping(payload);
    return {
      userId: (user._id as { toString(): string }).toString(),
      role: user.role,
      companyId: user.companyId?.toString(),
      parentFuelCompanyId,
    };
  }
}
