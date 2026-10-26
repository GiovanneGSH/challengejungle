import { Injectable, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EntityManager } from '@mikro-orm/postgresql';
import { StructuredLogger } from '../observability/StructuredLogger';
import { MetricsService } from '../observability/MetricsService';

@Injectable()
export class OutboxPublisherWorker {
  private isRunning = false;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async publishOutboxEvents() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      await this.em.transactional(async (txEm) => {
        const conn = txEm.getConnection();
        const now = new Date();

        const rows = (await txEm.execute(
          `SELECT * FROM outbox_messages
           WHERE published_at IS NULL
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY occurred_at ASC
           LIMIT 50
           FOR UPDATE SKIP LOCKED`,
          [now],
        )) as any[];

        for (const row of rows) {
          try {
            // Aqui em produção o evento seria despachado para o AWS SQS ou Broker de mensageria.
            // Para o escopo do desafio, marcamos como publicado na outbox com sucesso.
            const occurredAt = new Date(row.occurred_at);
            const lagMs = now.getTime() - occurredAt.getTime();
            this.metrics.setOutboxLagMs(lagMs);

            await txEm.execute(
              `UPDATE outbox_messages SET published_at = ? WHERE id = ?`,
              [now, row.id],
            );

            this.logger.info('OutboxEventPublished', {
              eventId: row.id,
              eventType: row.event_type,
              aggregateId: row.aggregate_id,
            });
          } catch (err: any) {
            const nextAttempts = Number(row.attempts) + 1;
            const backoffMs = Math.min(60_000, Math.pow(2, nextAttempts) * 500);
            const nextAttemptAt = new Date(now.getTime() + backoffMs);

            this.metrics.incrementRetries();
            await txEm.execute(
              `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ? WHERE id = ?`,
              [nextAttempts, nextAttemptAt, row.id],
            );

            this.logger.error('OutboxEventPublishFailed', {
              eventId: row.id,
              error: err.message,
              attempts: nextAttempts,
            });
          }
        }
      });
    } catch (err: any) {
      this.logger.error('OutboxPublisherWorkerError', { error: err.message });
    } finally {
      this.isRunning = false;
    }
  }
}