import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import {
  correlation,
  correlationId as validatedCorrelationId,
  securityEvent,
  telemetryScope,
} from './security-events.js';
import {
  transientFailure,
  TrustedOperationTransientError,
} from '../operations/operation-context.js';

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
  const id = validatedCorrelationId(request.headers['x-correlation-id']);
  response.setHeader('X-Correlation-Id', id);
  correlation.run(id, () => telemetryScope(next));
}
@Catch()
export class HttpSecurityErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId =
      correlation.getStore() ?? validatedCorrelationId(undefined);
    const emit = (event: Parameters<typeof securityEvent>[0]) =>
      correlation.run(correlationId, () => securityEvent(event));
    response.setHeader('X-Correlation-Id', correlationId);
    response.setHeader('Cache-Control', 'no-store');
    if (error instanceof HttpException) {
      const status = error.getStatus();
      if (status === 403) emit('AUTHORIZATION_REJECTED');
      if (status >= 500) {
        emit(status === 503 ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR');
        if (status === 503) response.setHeader('Retry-After', '1');
        response.status(status).json({
          statusCode: status,
          message:
            status === 503 ? 'Service unavailable' : 'Internal server error',
          correlationId,
        });
        return;
      }
      const body = error.getResponse();
      response.status(status).json({
        ...(typeof body === 'object' ? body : { message: body }),
        correlationId,
      });
    } else {
      const transient =
        error instanceof TrustedOperationTransientError ||
        transientFailure(error) !== null;
      emit(transient ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR');
      if (transient) response.setHeader('Retry-After', '1');
      response.status(transient ? 503 : 500).json({
        statusCode: transient ? 503 : 500,
        message: transient ? 'Service unavailable' : 'Internal server error',
        correlationId,
      });
    }
  }
}
