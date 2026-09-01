/** Every `Company` document is one of these (spec 004 FR-001). A `TRANSPORT`
 * company always has `parentFuelCompanyId` set; a `FUEL` company never does. */
export enum CompanyType {
  FUEL = 'FUEL',
  TRANSPORT = 'TRANSPORT',
}
