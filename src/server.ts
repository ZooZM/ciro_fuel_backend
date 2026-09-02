import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { configureApp } from './bootstrap/configure-app';
import { loadSecrets } from './secrets/secrets-loader';

async function bootstrap(): Promise<void> {
  // BEFORE NestFactory.create, and the ordering is the design (spec 012
  // research R8). `ConfigModule.forRoot` validates process.env with Joi at
  // construction time, so a Nest custom loader would run AFTER Joi and fail
  // validation before it ever loaded anything. Fetching into process.env first
  // means configuration.ts and validation.ts are untouched, and Joi stays the
  // single thing that fails on an absent secret (FR-049).
  //
  // A no-op unless SECRETS_DRIVER=gcp, so development and every test are
  // unaffected (FR-048). It THROWS on failure and nothing catches it: the
  // process exits without binding a port, so a partially-configured instance
  // never serves and never reports ready (FR-046).
  await loadSecrets();

  // Imported HERE, not at module scope, and that is load-bearing.
  //
  // A static `import { AppModule } from './app.module'` compiles to a
  // top-level `require`, which evaluates app.module.js — and therefore runs
  // `ConfigModule.forRoot`'s Joi validation — BEFORE this function's body is
  // ever reached. `loadSecrets()` would then populate process.env after Joi
  // had already rejected it, and the process would die reporting the secrets
  // as "required" rather than reporting why the store was not read.
  //
  // Invisible in development and in every test: SECRETS_DRIVER=env means
  // process.env is already populated, so Joi passes regardless of ordering.
  // It fails only under SECRETS_DRIVER=gcp — production alone.
  const { AppModule } = await import('./app.module');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Everything that shapes how the app handles a request lives in configureApp,
  // which the e2e factory calls too — so the suites exercise the same
  // configuration production runs (spec 012 research R1). Nothing that belongs
  // there should be added back here.
  configureApp(app);

  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Ciro Fuel Delivery Platform API')
      .setDescription('Multi-tenant B2B fuel delivery logistics platform')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);

    // Manual order-lifecycle test dashboard (`public/`), served same-origin so
    // it needs neither CORS nor a helmet CSP exemption. Dev/staging only — it
    // is a multi-role test console, never something a production origin hosts.
    //
    // Swagger and this console are genuinely production-excluded, which is why
    // they stay here rather than moving into configureApp.
    app.useStaticAssets(join(process.cwd(), 'public'), { prefix: '/dashboard' });
  }

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}

bootstrap();
