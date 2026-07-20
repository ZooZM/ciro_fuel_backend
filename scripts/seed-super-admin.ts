import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { UsersService } from '../src/modules/users/users.service';
import { UserRole } from '../src/common/enums/user-role.enum';

async function seed(): Promise<void> {
  const logger = new Logger('SeedSuperAdmin');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const config = app.get(ConfigService);
    const usersService = app.get(UsersService);

    const email = config.get<string>('superAdmin.email');
    const password = config.get<string>('superAdmin.password');
    const fullName = config.get<string>('superAdmin.fullName');

    if (!email || !password) {
      logger.error('SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD are not set — aborting.');
      process.exitCode = 1;
      return;
    }

    const existing = await usersService.findByEmailForAuth(email);
    if (existing) {
      logger.log(`Super admin already exists for ${email} — skipping (idempotent).`);
      return;
    }

    await usersService.create({
      email,
      password,
      fullName: fullName ?? 'Platform Owner',
      phone: 'N/A',
      role: UserRole.SUPER_ADMIN,
      isActive: true,
    });

    logger.log(`Super admin created for ${email}.`);
  } finally {
    await app.close();
  }
}

seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
