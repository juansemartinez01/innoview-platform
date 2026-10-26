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
  correlation.run(id, next);
}
@Catch()
export class HttpSecurityErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const status = error.getStatus();
      if (status === 403) securityEvent('AUTHORIZATION_REJECTED');
      response.status(status).json(error.getResponse());
    } else {
      securityEvent(databaseFailure(error));
      response
        .status(503)
        .json({ statusCode: 503, message: 'Service unavailable' });
    }
  }
}
