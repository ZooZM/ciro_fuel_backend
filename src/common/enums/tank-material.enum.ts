// spec 008 FR-048a/g: recorded fact about a tank, not a rule. Material does
// not by itself determine which fuel grades a tank may carry — that is
// `Tank.fuelTypes`, stated explicitly per tank.
export enum TankMaterial {
  IRON = 'IRON',
  ALUMINIUM = 'ALUMINIUM',
}
