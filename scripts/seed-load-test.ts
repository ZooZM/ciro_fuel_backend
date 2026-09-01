import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { CompaniesService } from '../src/modules/companies/companies.service';
import { UsersService } from '../src/modules/users/users.service';
import { UserRole } from '../src/common/enums/user-role.enum';
import { FuelType } from '../src/common/enums/fuel-type.enum';
import { CompanyStatus } from '../src/common/enums/company-status.enum';
import { CompanyType } from '../src/common/enums/company-type.enum';
import { GovernorateCode, RegionCode } from '../src/common/enums/region.enum';
import { TrucksService } from '../src/modules/trucks/trucks.service';
import { TanksService } from '../src/modules/tanks/tanks.service';
import { TankMaterial } from '../src/common/enums/tank-material.enum';
import { WarehousesService } from '../src/modules/warehouses/warehouses.service';

const COMPANY_COUNT = 50;
const USERS_PER_COMPANY = 10; // 1 admin + 4 clients + 5 drivers ≈ 500 total users
const PASSWORD = 'LoadTest123!';

// CLIENT/DRIVER phones are login identifiers and unique platform-wide. The
// `+96658` prefix keeps load-test numbers clear of hand-written fixture phones.
let phoneSeq = 0;
const nextPhone = (): string => `+96658${String(++phoneSeq).padStart(7, '0')}`;

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
  const trucksService = app.get(TrucksService);
  const tanksService = app.get(TanksService);
  const warehousesService = app.get(WarehousesService);

  try {
    // spec 008 FR-035f: assignment refuses without a warehouse supplying the
    // order's grade — one covering every fuel type this script seeds is
    // enough for the whole run (`findNearestSupplying` has no distance cap).
    await warehousesService.create({
      name: 'Load Test Warehouse',
      location: { longitude: 46.6753, latitude: 24.7136 },
      addressText: 'Load test warehouse',
      region: RegionCode.RIYADH,
      governorate: GovernorateCode.RIYADH_CITY,
      fuelTypes: [FuelType.DIESEL],
    });

    for (let c = 0; c < COMPANY_COUNT; c++) {
      const company = await companiesService.create({
        name: `Load Test Co ${c}`,
        type: CompanyType.FUEL,
        status: CompanyStatus.ACTIVE,
        contactEmail: `contact${c}@loadtest.example`,
        contactPhone: '+966500000000',
        fuelPrices: [{ fuelType: FuelType.DIESEL, basePricePerLiter: 2.5 }],
      });

      await usersService.create({
        companyId: company._id as never,
        role: UserRole.FUEL_COMPANY_ADMIN,
        email: `admin${c}@loadtest.example`,
        password: PASSWORD,
        fullName: `Load Admin ${c}`,
        phone: nextPhone(),
        isActive: true,
      });

      for (let i = 0; i < 4; i++) {
        await usersService.create({
          companyId: company._id as never,
          role: UserRole.CLIENT,
          email: `client${c}-${i}@loadtest.example`,
          password: PASSWORD,
          fullName: `Load Client ${c}-${i}`,
          phone: nextPhone(),
          isActive: true,
          station: {
            regionCode: RegionCode.RIYADH,
            governorateCode: GovernorateCode.RIYADH_CITY,
            location: { type: 'Point', coordinates: [46.6753 + i * 0.01, 24.7136] },
            addressText: '',
          } as never,
        });
      }

      for (let i = 0; i < 5; i++) {
        await usersService.create({
          companyId: company._id as never,
          role: UserRole.DRIVER,
          email: `driver${c}-${i}@loadtest.example`,
          password: PASSWORD,
          fullName: `Load Driver ${c}-${i}`,
          phone: nextPhone(),
          isActive: true,
          isOnline: true,
          isAvailable: true,
          lastSeenAt: new Date(),
          location: { type: 'Point', coordinates: [46.6753, 24.7136 + i * 0.01] } as never,
        });

        // spec 008 (research R12): a real Truck/Tank pair replaces the
        // driver's deleted embedded truck — one of each per seeded driver,
        // matching the capacity/grade the old embedded truck used to carry.
        const truck = await trucksService.create(String(company._id), {
          plateNumber: `LT-${c}-${i}`,
        });
        await trucksService.pairCard(String(truck._id), `LT-CARD-${c}-${i}`);
        await tanksService.create(String(company._id), {
          code: `LT-TANK-${c}-${i}`,
          material: TankMaterial.ALUMINIUM,
          maxCapacityLiters: 5000,
          fuelTypes: [FuelType.DIESEL],
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
