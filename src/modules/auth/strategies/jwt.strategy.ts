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
      // spec 015 T023a — carried from the VERIFIED token, never re-read from
      // the account (same discipline as `sgen` on the socket path). Present
      // only for admin roles. `AuthController.logout` is the one handler
      // permitted to read it: it needs to name the single session it closes.
      sid: payload.sid,
    };
  }
}
