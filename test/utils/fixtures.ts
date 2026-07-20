import { INestApplication } from '@nestjs/common';
import { UsersService } from '../../src/modules/users/users.service';
import { CompaniesService } from '../../src/modules/companies/companies.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { UserRole } from '../../src/common/enums/user-role.enum';
import { FuelType } from '../../src/common/enums/fuel-type.enum';
import { CompanyStatus } from '../../src/common/enums/company-status.enum';

export const DEFAULT_PASSWORD = 'Password123!';

export interface CompanyFixture {
  companyId: string;
  admin: { id: string; email: string; token: string };
  client: { id: string; email: string; token: string; stationLocation: [number, number] };
  driver: {
    id: string;
    email: string;
    token: string;
    location: [number, number];
    maxCapacityLiters: number;
  };
}

export interface TwoCompanyFixture {
  superAdmin: { id: string; email: string; token: string };
  companyA: CompanyFixture;
  companyB: CompanyFixture;
}

async function createCompanyFixture(
  app: INestApplication,
  name: string,
  center: [number, number],
): Promise<CompanyFixture> {
  const companiesService = app.get(CompaniesService);
  const usersService = app.get(UsersService);
  const authService = app.get(AuthService);

  const company = await companiesService.create({
    name,
    status: CompanyStatus.ACTIVE,
    contactEmail: `contact@${name.toLowerCase().replace(/\s+/g, '')}.test`,
    contactPhone: '+966500000000',
    fuelPrices: [
      { fuelType: FuelType.DIESEL, basePricePerLiter: 2.5 },
      { fuelType: FuelType.PETROL_91, basePricePerLiter: 2.2 },
    ],
  });
  const companyId = (company._id as { toString(): string }).toString();

  const admin = await usersService.create({
    companyId: company._id as never,
    role: UserRole.COMPANY_ADMIN,
    email: `admin@${name.toLowerCase().replace(/\s+/g, '')}.test`,
    password: DEFAULT_PASSWORD,
    fullName: `${name} Admin`,
    phone: '+966500000001',
    isActive: true,
  });

  const stationLocation: [number, number] = [center[0] + 0.01, center[1] + 0.01];
  const client = await usersService.create({
    companyId: company._id as never,
    role: UserRole.CLIENT,
    email: `client@${name.toLowerCase().replace(/\s+/g, '')}.test`,
    password: DEFAULT_PASSWORD,
    fullName: `${name} Client`,
    phone: '+966500000002',
    isActive: true,
    stationLocation: { type: 'Point', coordinates: stationLocation } as never,
  });

  const driverLocation: [number, number] = [center[0], center[1]];
  const maxCapacityLiters = 5000;
  const driver = await usersService.create({
    companyId: company._id as never,
    role: UserRole.DRIVER,
    email: `driver@${name.toLowerCase().replace(/\s+/g, '')}.test`,
    password: DEFAULT_PASSWORD,
    fullName: `${name} Driver`,
    phone: '+966500000003',
    isActive: true,
    isAvailable: true,
    isOnline: true,
    lastSeenAt: new Date(),
    location: { type: 'Point', coordinates: driverLocation } as never,
    truck: {
      plateNumber: `${name.slice(0, 3).toUpperCase()}-001`,
      maxCapacityLiters,
      fuelTypes: [FuelType.DIESEL, FuelType.PETROL_91],
    } as never,
  });

  const [adminAuth, clientAuth, driverAuth] = await Promise.all([
    authService.login(admin.email, DEFAULT_PASSWORD),
    authService.login(client.email, DEFAULT_PASSWORD),
    authService.login(driver.email, DEFAULT_PASSWORD),
  ]);

  return {
    companyId,
    admin: { id: String(admin._id), email: admin.email, token: adminAuth.accessToken },
    client: {
      id: String(client._id),
      email: client.email,
      token: clientAuth.accessToken,
      stationLocation,
    },
    driver: {
      id: String(driver._id),
      email: driver.email,
      token: driverAuth.accessToken,
      location: driverLocation,
      maxCapacityLiters,
    },
  };
}

export async function seedTwoCompanies(app: INestApplication): Promise<TwoCompanyFixture> {
  const usersService = app.get(UsersService);
  const authService = app.get(AuthService);

  const superAdminUser = await usersService.create({
    role: UserRole.SUPER_ADMIN,
    email: 'owner@platform.test',
    password: DEFAULT_PASSWORD,
    fullName: 'Platform Owner',
    phone: '+966500000099',
    isActive: true,
  });
  const superAdminAuth = await authService.login(superAdminUser.email, DEFAULT_PASSWORD);

  const [companyA, companyB] = await Promise.all([
    createCompanyFixture(app, 'CompanyA', [46.6753, 24.7136]),
    createCompanyFixture(app, 'CompanyB', [39.1925, 21.4858]),
  ]);

  return {
    superAdmin: {
      id: String(superAdminUser._id),
      email: superAdminUser.email,
      token: superAdminAuth.accessToken,
    },
    companyA,
    companyB,
  };
}
