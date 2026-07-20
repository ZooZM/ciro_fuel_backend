import { Types } from 'mongoose';
import { UserRole } from '../enums/user-role.enum';
import { TransitionActor } from '../../modules/orders/services/order-state.service';

/**
 * Attributes automated order-lifecycle transitions (auto-dispatch, payment
 * webhook confirmation, payment-timeout reversion) to the platform itself
 * rather than misattributing them to whichever driver/order happens to be
 * involved. FR-010 requires every transition to record an actor; there is no
 * human actor for these, so a fixed, well-known identity is used under the
 * SUPER_ADMIN role (the platform's own scope).
 */
export const SYSTEM_ACTOR_ID = new Types.ObjectId('000000000000000000000000');

export const SYSTEM_ACTOR: TransitionActor = {
  actorId: SYSTEM_ACTOR_ID.toString(),
  actorRole: UserRole.SUPER_ADMIN,
};
