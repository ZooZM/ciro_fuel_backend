// spec 011 FR-005/SC-003: a fixed, translated list rather than free text
// alone — a driver answering at the roadside, possibly dealing with the
// problem itself, must be able to reply in one tap without typing. OTHER is
// the escape hatch, and is the only value that carries free text alongside
// it (`StopEvent.reasonText`).
//
// Shared vocabulary: the driver app renders these as the choices and the
// transport dashboard renders the same seven values back — the admin is
// reading exactly what the driver picked, so neither surface may invent a
// value the other does not know.
export enum StopReason {
  TRAFFIC = 'TRAFFIC',
  VEHICLE_PROBLEM = 'VEHICLE_PROBLEM',
  REST_OR_PRAYER = 'REST_OR_PRAYER',
  REFUELLING = 'REFUELLING',
  ROAD_CLOSURE = 'ROAD_CLOSURE',
  ACCIDENT = 'ACCIDENT',
  OTHER = 'OTHER',
}
