import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SMS_SENDER } from './sms-sender.port';
import { NoopSmsSender } from './noop-sms-sender';

/**
 * Global so `PhoneVerificationService` (spec 005 US7) can inject
 * `SMS_SENDER` without every importing module wiring it explicitly —
 * matching the pattern `RedisModule`/`RealtimeModule` already use.
 *
 * Only `'none'` has an implementation today (research R4 — the provider
 * decision is deliberately deferred). Selecting any other value throws at
 * bootstrap rather than silently falling back to the no-op sender: a
 * deployment that believes it configured a real provider must fail loudly,
 * not quietly stop sending codes. `validation.ts` already limits
 * `SMS_PROVIDER` to the values a real adapter will eventually exist for
 * (`none | unifonic | twilio`), so this factory's `default` case is
 * reachable only once one of those is chosen without its adapter having
 * been built yet — exactly the case that should fail loudly.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    NoopSmsSender,
    {
      provide: SMS_SENDER,
      inject: [ConfigService, NoopSmsSender],
      useFactory: (config: ConfigService, noop: NoopSmsSender) => {
        const provider = config.get<string>('sms.provider');
        switch (provider) {
          case 'none':
            return noop;
          default:
            throw new Error(
              `SMS_PROVIDER=${provider} has no sender implementation yet — only 'none' ` +
                '(the development no-op) is wired. See src/common/sms/sms.module.ts.',
            );
        }
      },
    },
  ],
  exports: [SMS_SENDER],
})
export class SmsModule {}
