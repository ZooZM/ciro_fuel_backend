/**
 * SUPER_ADMIN is CIRO, the platform operator — the only role exempt from
 * tenant isolation (spec 004 FR-003). COMPANY_ADMIN split into two roles
 * because "the company" is no longer one thing: a FUEL_COMPANY_ADMIN owns
 * pricing, client relationships and order approval; a TRANSPORT_COMPANY_ADMIN
 * owns a driver fleet and picks up routed orders (spec 004 FR-001).
 */
export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  FUEL_COMPANY_ADMIN = 'FUEL_COMPANY_ADMIN',
  TRANSPORT_COMPANY_ADMIN = 'TRANSPORT_COMPANY_ADMIN',
  CLIENT = 'CLIENT',
  DRIVER = 'DRIVER',
}
