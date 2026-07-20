import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { CompaniesService } from '../src/modules/companies/companies.service';
import { UsersService } from '../src/modules/users/users.service';
import { UserRole } from '../src/common/enums/user-role.enum';
import { FuelType } from '../src/common/enums/fuel-type.enum';
import { CompanyStatus } from '../src/common/enums/company-status.enum';

const COMPANY_COUNT = 50;
const USERS_PER_COMPANY = 10; // 1 admin + 4 clients + 5 drivers ≈ 500 total users
const PASSWORD = 'LoadTest123!';

/**
 * Seeds SC-008's scale target (50 tenants / ~500 users) so a load tool
 * (autocannon, k6, etc.) has realistic multi-tenant data to hit — see
 * test/perf/README.md for how to actually drive load against this.
 */
async function seed(): Promise<void> {
  const logger = new Logger('SeedLoadTest');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const companiesService = app.get(CompaniesService);
  const usersService = app.get(UsersService);

  try {
    for (let c = 0; c < COMPANY_COUNT; c++) {
      const company = await companiesService.create({
        name: `Load Test Co ${c}`,
        status: CompanyStatus.ACTIVE,
        contactEmail: `contact${c}@loadtest.example`,
        contactPhone: '+966500000000',
        fuelPrices: [{ fuelType: FuelType.DIESEL, basePricePerLiter: 2.5 }],
      });

      await usersService.create({
        companyId: company._id as never,
        role: UserRole.COMPANY_ADMIN,
        email: `admin${c}@loadtest.example`,
        password: PASSWORD,
        fullName: `Load Admin ${c}`,
        phone: '+966500000001',
        isActive: true,
      });

      for (let i = 0; i < 4; i++) {
        await usersService.create({
          companyId: company._id as never,
          role: UserRole.CLIENT,
          email: `client${c}-${i}@loadtest.example`,
          password: PASSWORD,
          fullName: `Load Client ${c}-${i}`,
          phone: '+966500000002',
          isActive: true,
          stationLocation: { type: 'Point', coordinates: [46.6753 + i * 0.01, 24.7136] } as never,
        });
      }

      for (let i = 0; i < 5; i++) {
        await usersService.create({
          companyId: company._id as never,
          role: UserRole.DRIVER,
          email: `driver${c}-${i}@loadtest.example`,
          password: PASSWORD,
          fullName: `Load Driver ${c}-${i}`,
          phone: '+966500000003',
          isActive: true,
          isOnline: true,
          isAvailable: true,
          lastSeenAt: new Date(),
          location: { type: 'Point', coordinates: [46.6753, 24.7136 + i * 0.01] } as never,
          truck: {
            plateNumber: `LT-${c}-${i}`,
            maxCapacityLiters: 5000,
            fuelTypes: [FuelType.DIESEL],
          } as never,
        });
      }

      if ((c + 1) % 10 === 0) {
        logger.log(`Seeded ${c + 1}/${COMPANY_COUNT} companies...`);
      }
    }

    logger.log(
      `Done: ${COMPANY_COUNT} companies, ~${COMPANY_COUNT * USERS_PER_COMPANY} users (login password: ${PASSWORD}).`,
    );
  } finally {
    await app.close();
  }
}

seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
