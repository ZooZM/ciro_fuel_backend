import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PasswordResetService } from './services/password-reset.service';
import { PasswordReset, PasswordResetSchema } from './schemas/password-reset.schema';
import { LoginCode, LoginCodeSchema } from './schemas/login-code.schema';
import { LoginCodeService } from './services/login-code.service';
import { LoginAbuseService } from './services/login-abuse.service';
import { ChallengeService, CHALLENGE_PROVIDER } from './services/challenge.service';
import { UsersModule } from '../users/users.module';
import { StationsModule } from '../stations/stations.module';

@Module({
  imports: [
    UsersModule,
    StationsModule,
    PassportModule,
    MongooseModule.forFeature([
      { name: PasswordReset.name, schema: PasswordResetSchema },
      { name: LoginCode.name, schema: LoginCodeSchema },
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret'),
        signOptions: { expiresIn: config.get<string>('jwt.expiresIn') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    PasswordResetService,
    LoginCodeService,
    LoginAbuseService,
    // spec 015 R7 — the proof-of-work lives behind an interface so it can be
    // swapped for a third-party CAPTCHA as one adapter.
    { provide: CHALLENGE_PROVIDER, useClass: ChallengeService },
  ],
  exports: [AuthService],
})
export class AuthModule {}
