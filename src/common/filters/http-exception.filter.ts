import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

interface UniformErrorBody {
  statusCode: number;
  message: string | string[];
  error: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const uniform: UniformErrorBody =
        typeof body === 'string'
          ? { statusCode: status, message: body, error: exception.name }
          : {
              statusCode: status,
              message: (body as { message?: string | string[] }).message ?? exception.message,
              error: (body as { error?: string }).error ?? exception.name,
            };
      response.status(status).json(uniform);
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'InternalServerError',
    });
  }
}
