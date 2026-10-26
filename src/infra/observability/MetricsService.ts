import { Injectable } from '@nestjs/common';

@Injectable()
export class MetricsService {
  private readonly transactionsByStatus: Record<string, number> = {
    PROCESSED: 0,
    REJECTED: 0,
    PENDING_REFERENCE: 0,
    FAILED: 0,
  };
  private duplicatesDetected = 0;
  private retriesCount = 0;
  private dlqMessagesCount = 0;
  private lockConflictsCount = 0;
  private reconciliationDiscrepancies = 0;
  private outboxLagMs = 0;
  private readonly processingLatenciesMs: number[] = [];

  incrementTransactionStatus(status: string): void {
    this.transactionsByStatus[status] = (this.transactionsByStatus[status] ?? 0) + 1;
  }

  incrementDuplicates(): void {
    this.duplicatesDetected += 1;
  }

  incrementRetries(): void {
    this.retriesCount += 1;
  }

  incrementDlqMessages(): void {
    this.dlqMessagesCount += 1;
  }

  incrementLockConflicts(): void {
    this.lockConflictsCount += 1;
  }

  incrementReconciliationDiscrepancies(): void {
    this.reconciliationDiscrepancies += 1;
  }

  setOutboxLagMs(lagMs: number): void {
    this.outboxLagMs = Math.max(0, lagMs);
  }

  recordLatencyMs(durationMs: number): void {
    this.processingLatenciesMs.push(durationMs);
    if (this.processingLatenciesMs.length > 5000) {
      this.processingLatenciesMs.shift();
    }
  }

  getSnapshot() {
    const sorted = [...this.processingLatenciesMs].sort((a, b) => a - b);
    const percentile = (p: number) => {
      if (sorted.length === 0) return 0;
      const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
      return Number(sorted[idx].toFixed(2));
    };

    return {
      transactionsByStatus: { ...this.transactionsByStatus },
      duplicatesDetected: this.duplicatesDetected,
      retriesCount: this.retriesCount,
      dlqMessagesCount: this.dlqMessagesCount,
      lockConflictsCount: this.lockConflictsCount,
      reconciliationDiscrepancies: this.reconciliationDiscrepancies,
      outboxLagMs: this.outboxLagMs,
      processingLatencyMs: {
        count: sorted.length,
        p50: percentile(50),
        p95: percentile(95),
        p99: percentile(99),
      },
    };
  }
}