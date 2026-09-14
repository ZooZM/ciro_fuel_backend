import { TruckDocument } from './schemas/truck.schema';

/**
 * The ONLY shape in which a truck leaves the platform.
 *
 * spec 008 FR-042: `nfcCardUid` and `qrToken` are never exposed as readable
 * fields — a truck's card identifier and its rotatable QR token are both
 * credentials that `VehicleVerificationService.resolveCredential` accepts, so
 * handing either to a caller hands over the ability to pass a verification
 * without the vehicle. They are replaced here by the `hasCard`/`hasCode`
 * booleans, which answer the only question a reader legitimately has (is this
 * vehicle verifiable yet — FR-053).
 *
 * This lived as a private method on `TrucksController`, which is why
 * `DispatchService.getCandidates` could return a raw `TruckDocument` as each
 * candidate's `suggestedTruck` and disclose both credentials to the assignment
 * screen — the guard existed but was not reachable from the second place that
 * needed it. It is a free function precisely so there is one implementation
 * and no second copy to drift from.
 */
export function toSafeTruckShape(truck: TruckDocument) {
  return {
    id: String(truck._id),
    companyId: String(truck.companyId),
    plateNumber: truck.plateNumber,
    model: truck.model ?? null,
    hasCard: Boolean(truck.nfcCardUid),
    hasCode: Boolean(truck.qrToken),
    isActive: truck.isActive,
    activeOrderId: truck.activeOrderId ? String(truck.activeOrderId) : null,
  };
}

export type SafeTruck = ReturnType<typeof toSafeTruckShape>;
