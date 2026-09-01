import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { SessionEvent, SessionEventSchema } from './schemas/session-event.schema';
import { SessionAuditService } from './session-audit.service';

/**
 * A leaf module (spec 006 research R7): both `auth/` (sign-in, sign-out,
 * password reset) and `users/` (deactivation) write session events, so the
 * writer lives here rather than in either — importing one from the other
 * would make the two depend on each other sideways. `@Global()` so those
 * modules can inject `SessionAuditService` without each importing this
 * module explicitly, matching the established pattern for a leaf service
 * with multiple consumers (`RealtimeModule`, `SmsModule`).
 */
@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: SessionEvent.name, schema: SessionEventSchema }])],
  providers: [SessionAuditService],
  exports: [SessionAuditService],
})
export class SessionsModule {}
