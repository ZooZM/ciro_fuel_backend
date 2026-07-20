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
    // Re-checks isActive + company status on every request — see UsersService docstring.
    const user = await this.usersService.validateActiveSession(payload.sub);
    return {
      userId: (user._id as { toString(): string }).toString(),
      role: user.role,
      companyId: user.companyId?.toString(),
    };
  }
}
