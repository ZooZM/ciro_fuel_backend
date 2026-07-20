import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { AppModule } from '../../src/app.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';

export interface TestAppContext {
  app: INestApplication;
  replSet: MongoMemoryReplSet;
  /** Base HTTP URL of the actually-listening server — needed by socket.io-client (unlike Supertest, it needs a real bound port). */
  url: string;
  close: () => Promise<void>;
}

/**
 * Boots the full AppModule against a real single-node Mongo replica set
 * (mongodb-memory-server) so multi-document transactions behave exactly as
 * in production, plus a real Redis (REDIS_URL, default localhost — see
 * quickstart.md / CI service container) since BullMQ delayed-job semantics
 * don't hold up against mocks (research.md R12).
 */
export async function createTestApp(): Promise<TestAppContext> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  process.env.MONGODB_URI = replSet.getUri('ciro_fuel_test');
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
  process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret-0123456789abcdef';
  process.env.PAYMENT_SADAD_SECRET = 'sadad-test-secret';
  process.env.PAYMENT_MADA_SECRET = 'mada-test-secret';
  process.env.PAYMENT_DEADLINE_MINUTES = process.env.PAYMENT_DEADLINE_MINUTES ?? '30';

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication({ rawBody: true });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  // listen() (not just init()) so socket.io-client has a real port to connect
  // to — Supertest keeps working identically either way (in-process requests).
  await app.listen(0);
  const url = await app.getUrl();

  return {
    app,
    replSet,
    url,
    close: async () => {
      await app.close();
      await replSet.stop();
    },
  };
}
