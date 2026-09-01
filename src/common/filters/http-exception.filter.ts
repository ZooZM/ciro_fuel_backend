import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { TenantContextService } from '../context/tenant-context.service';

interface UniformErrorBody {
  statusCode: number;
  message: string | string[];
  error: string;
  [key: string]: unknown;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  /**
   * Optional, and instantiated by hand at both bootstrap sites rather than
   * injected — `useGlobalFilters` takes an instance, not a token, so there is
   * no container to resolve from. An absent context service degrades to a
   * record with no correlation id, which is what the filter produced before
   * spec 012; it never changes the RESPONSE.
   */
  constructor(private readonly tenantContext?: TenantContextService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // Every object-shaped body here is one this codebase's own
      // application code constructed on purpose — never a bare/generic
      // error (those fall through to the branch below). spec 005's
      // QUOTE_STALE is the reason extra fields (`currentBreakdown`) are
      // preserved rather than dropped: the uniform envelope's job is to
      // guarantee statusCode/message/error are always present, not to
      // strip whatever else a deliberate exception body carries.
      const uniform: UniformErrorBody =
        typeof body === 'string'
          ? { statusCode: status, message: body, error: exception.name }
          : {
              ...(body as Record<string, unknown>),
              statusCode: status,
              message: (body as { message?: string | string[] }).message ?? exception.message,
              error: (body as { error?: string }).error ?? exception.name,
            };
      response.status(status).json(uniform);
      return;
    }

    // FR-034. The RECORD gains the correlation id; the RESPONSE stays
    // byte-identical to what it has always been. That asymmetry is the whole
    // requirement: an unhandled failure must be findable by the same id as the
    // request that caused it, and a client must learn nothing new about the
    // platform's internals from the fact that it now is. Anything added to the
    // body below — an id, a stack, an exception name — is a disclosure.
    this.logger.error(
      {
        correlationId: this.tenantContext?.getCorrelationId(),
        err: exception instanceof Error ? exception : new Error(String(exception)),
      },
      'Unhandled exception',
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'InternalServerError',
    });
  }
}
