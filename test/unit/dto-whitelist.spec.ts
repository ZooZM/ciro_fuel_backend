import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOrderDto } from '../../src/modules/orders/dto/create-order.dto';
import { ApproveOrderDto } from '../../src/modules/orders/dto/approve-order.dto';
import { CancelOrderDto } from '../../src/modules/orders/dto/cancel-order.dto';
import { LoginDto } from '../../src/modules/auth/dto/login.dto';

/**
 * Mirrors the global ValidationPipe config in server.ts / test-app.factory.ts
 * ({ whitelist: true, forbidNonWhitelisted: true }) — the actual backstop
 * behind FR-002/tenant isolation: even if a handler forgot to strip
 * `companyId` from a request body before use, the pipe rejects the request
 * before it ever reaches a service (US2).
 */
async function assertRejectsExtraField(
  dtoClass: new () => object,
  validBody: Record<string, unknown>,
  extraField: Record<string, unknown>,
): Promise<void> {
  const instance = plainToInstance(dtoClass, { ...validBody, ...extraField });
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  expect(errors.length).toBeGreaterThan(0);
  const rejectedProps = errors.map((e) => e.property);
  expect(rejectedProps).toEqual(expect.arrayContaining(Object.keys(extraField)));
}

async function assertAcceptsValidBody(
  dtoClass: new () => object,
  validBody: Record<string, unknown>,
): Promise<void> {
  const instance = plainToInstance(dtoClass, validBody);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  expect(errors).toHaveLength(0);
}

describe('DTO whitelist enforcement (FR-002 backstop)', () => {
  it('CreateOrderDto rejects a smuggled companyId', async () => {
    await assertAcceptsValidBody(CreateOrderDto, { fuelType: 'DIESEL', quantityLiters: 500 });
    await assertRejectsExtraField(
      CreateOrderDto,
      { fuelType: 'DIESEL', quantityLiters: 500 },
      { companyId: '000000000000000000000000' },
    );
  });

  it('ApproveOrderDto rejects a smuggled approvedBy/companyId override', async () => {
    await assertAcceptsValidBody(ApproveOrderDto, { finalPrice: 100 });
    await assertRejectsExtraField(
      ApproveOrderDto,
      { finalPrice: 100 },
      { companyId: '000000000000000000000000', approvedBy: '000000000000000000000000' },
    );
  });

  it('CancelOrderDto rejects a smuggled status override', async () => {
    await assertAcceptsValidBody(CancelOrderDto, { reason: 'changed my mind' });
    await assertRejectsExtraField(
      CancelOrderDto,
      { reason: 'changed my mind' },
      { status: 'DELIVERED' },
    );
  });

  it('LoginDto rejects a smuggled role/companyId (auth is the tightest boundary)', async () => {
    await assertAcceptsValidBody(LoginDto, { email: 'a@b.com', password: 'x' });
    await assertRejectsExtraField(
      LoginDto,
      { email: 'a@b.com', password: 'x' },
      { role: 'SUPER_ADMIN', companyId: '000000000000000000000000' },
    );
  });
});
