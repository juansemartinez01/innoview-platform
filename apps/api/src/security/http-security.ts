import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  correlation,
  correlationId,
  databaseFailure,
  securityEvent,
  telemetryScope,
} from './security-events.js';

interface Response {
  status(code: number): Response;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}
export function correlate(
  request: { headers: Record<string, unknown> },
  response: Response,
  next: () => void,
) {
  const id = correlationId(request.headers['x-correlation-id']);
  response.setHeader('X-Correlation-Id', id);
  correlation.run(id, () => telemetryScope(next));
}
@Catch()
export class HttpSecurityErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId = correlation.getStore();
    response.setHeader('Cache-Control', 'no-store');
    if (error instanceof HttpException) {
      const status = error.getStatus();
      if (status === 403) securityEvent('AUTHORIZATION_REJECTED');
      if (status === 503) response.setHeader('Retry-After', '1');
      const body = error.getResponse();
      response.status(status).json({
        ...(typeof body === 'object' ? body : { message: body }),
        correlationId,
      });
    } else {
      securityEvent(databaseFailure(error));
      response.setHeader('Retry-After', '1');
      response.status(503).json({
        statusCode: 503,
        message: 'Service unavailable',
        correlationId,
      });
    }
  }
}
