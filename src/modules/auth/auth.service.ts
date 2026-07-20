import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { UserDocument } from '../users/schemas/user.schema';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const GENERIC_AUTH_ERROR = 'Invalid credentials'; // never distinguish bad password vs inactive vs suspended

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string): Promise<TokenPair & { user: SafeUser }> {
    const user = await this.usersService.findByEmailForAuth(email);
    if (!user) {
      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }

    const passwordMatches = await UsersService.comparePassword(password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }

    // Re-run the same active-session checks used on every subsequent request.
    await this.usersService.validateActiveSession((user._id as { toString(): string }).toString());

    return { ...(await this.issueTokenPair(user)), user: toSafeUser(user) };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.config.get<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }

    const user = await this.usersService.validateActiveSession(payload.sub);
    return this.issueTokenPair(user);
  }

  private async issueTokenPair(user: UserDocument): Promise<TokenPair> {
    const payload: JwtPayload = {
      sub: (user._id as { toString(): string }).toString(),
      role: user.role,
      companyId: user.companyId?.toString(),
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.config.get<string>('jwt.secret'),
        expiresIn: this.config.get<string>('jwt.expiresIn'),
      }),
      this.jwtService.signAsync(payload, {
        secret: this.config.get<string>('jwt.refreshSecret'),
        expiresIn: this.config.get<string>('jwt.refreshExpiresIn'),
      }),
    ]);

    return { accessToken, refreshToken };
  }
}

export interface SafeUser {
  id: string;
  role: string;
  companyId?: string;
  fullName: string;
  email: string;
}

function toSafeUser(user: UserDocument): SafeUser {
  return {
    id: (user._id as { toString(): string }).toString(),
    role: user.role,
    companyId: user.companyId?.toString(),
    fullName: user.fullName,
    email: user.email,
  };
}
