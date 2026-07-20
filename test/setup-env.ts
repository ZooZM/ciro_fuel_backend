/**
 * Runs (via jest's `setupFiles`) BEFORE any test file is evaluated — critically,
 * before anything imports AppModule. @nestjs/config's ConfigModule.forRoot()
 * validates process.env synchronously the moment app.module.ts's @Module()
 * decorator runs (i.e. at import time), so placeholder-but-valid values must
 * already exist here. createTestApp() later overwrites MONGODB_URI with the
 * real MongoMemoryReplSet URI before compiling the testing module; since the
 * `configuration()` loader factory is only invoked when Nest's DI container
 * instantiates ConfigModule (during .compile()/app.init(), not at import
 * time), it picks up the corrected value — only this eager presence/format
 * check needs a placeholder.
 */
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/placeholder';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-jwt-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET ??= 'test-jwt-refresh-secret-0123456789abcdef';
process.env.PAYMENT_SADAD_SECRET ??= 'sadad-test-secret';
process.env.PAYMENT_MADA_SECRET ??= 'mada-test-secret';
