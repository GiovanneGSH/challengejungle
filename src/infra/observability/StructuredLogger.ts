import { Injectable } from '@nestjs/common';

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

@Injectable()
export class StructuredLogger {
  info(event: string, context: LogContext = {}): void {
    this.write('INFO', event, context);
  }

  warn(event: string, context: LogContext = {}): void {
    this.write('WARN', event, context);
  }

  error(event: string, context: LogContext = {}): void {
    this.write('ERROR', event, context);
  }

  private write(level: 'INFO' | 'WARN' | 'ERROR', event: string, context: LogContext): void {
    // Evita poluir o console durante baterias massivas de teste se SILENT_LOGS=true
    if (process.env.SILENT_LOGS === 'true' && level !== 'ERROR') {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      correlationId: context.correlationId ?? null,
      messageId: context.messageId ?? null,
      transactionId: context.transactionId ?? null,
      walletId: context.walletId ?? null,
      providerId: context.providerId ?? null,
      ...this.sanitize(context),
    };

    process.stdout.write(JSON.stringify(entry) + '\n');
  }

  /** Remove campos sensíveis ou objetos monetários brutos acidentais */
  private sanitize(context: LogContext): Record<string, unknown> {
    const clone: Record<string, unknown> = { ...context };
    delete clone.money;
    delete clone.balance;
    delete clone.initialBalance;
    delete clone.payload;
    return clone;
  }
}