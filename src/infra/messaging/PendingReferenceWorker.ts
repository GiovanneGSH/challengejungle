import { Injectable, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/ProcessWagerTransactionUseCase';
import { StructuredLogger } from '../observability/StructuredLogger';

@Injectable()
export class PendingReferenceWorker {
  private isRunning = false;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  @Cron(CronExpression.EVERY_SECOND)
  async handlePendingReferences() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const conn = this.em.getConnection();
      const rows = (await conn.execute(
        `SELECT id FROM wager_transactions
         WHERE status = 'PENDING_REFERENCE'
           AND (next_retry_at IS NULL OR next_retry_at <= NOW())
         LIMIT 20`,
      )) as any[];

      for (const row of rows) {
        try {
          await this.processWagerUseCase.reprocessPendingReference(row.id);
        } catch (err: any) {
          this.logger.error('PendingReferenceWorkerItemError', {
            transactionId: row.id,
            error: err.message,
          });
        }
      }
    } catch (err: any) {
      this.logger.error('PendingReferenceWorkerError', { error: err.message });
    } finally {
      this.isRunning = false;
    }
  }
}