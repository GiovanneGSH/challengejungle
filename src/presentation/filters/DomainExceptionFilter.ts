import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import {
  CurrencyMismatchError,
  DomainError,
  IdempotencyConflictError,
  InsufficientFundsError,
} from '../../domain/errors/DomainErrors';
import {
  ConflictApplicationError,
  NotFoundApplicationError,
} from '../../application/ports/ProviderIdentityPort';

@Catch(Error)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: Error, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = exception.message;

    if (exception instanceof DomainError) {
      code = exception.code;
      if (
        exception instanceof InsufficientFundsError ||
        exception.code === 'NEGATIVE_BALANCE_ON_REVERSAL' ||
        exception.code === 'INVALID_REFERENCE_KIND' ||
        exception.code === 'DUPLICATE_REVERSAL' ||
        exception.code === 'REFERENCE_MISMATCH' ||
        exception.code === 'REFERENCE_NOT_PROCESSED' ||
        exception.code === 'CURRENCY_MISMATCH' ||
        exception.code === 'WALLET_OWNERSHIP_MISMATCH'
      ) {
        status = HttpStatus.UNPROCESSABLE_ENTITY; // 422 - Rejeição por regra de negócio
      } else {
        status = HttpStatus.BAD_REQUEST; // 400 - Erro de validação ou payload
      }
    } else if (exception instanceof IdempotencyConflictError || exception instanceof ConflictApplicationError) {
      status = HttpStatus.CONFLICT; // 409 - Conflito de Idempotência ou Wallet Duplicada
      code = exception.code;
    } else if (exception instanceof NotFoundApplicationError) {
      status = HttpStatus.NOT_FOUND; // 404
      code = exception.code;
    }

    response.status(status).json({
      statusCode: status,
      errorCode: code,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}