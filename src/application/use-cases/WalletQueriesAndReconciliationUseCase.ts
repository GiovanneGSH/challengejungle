import { Injectable, Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/value-objects/Money';
import { NotFoundApplicationError } from '../ports/ProviderIdentityPort';
import { StructuredLogger } from '../../infra/observability/StructuredLogger';
import { MetricsService } from '../../infra/observability/MetricsService';

@Injectable()
export class WalletQueriesAndReconciliationUseCase {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async getWalletById(walletId: string) {
    const conn = this.em.getConnection();
    const rows = await conn.execute<any[]>(`SELECT * FROM wallets WHERE id = ?`, [walletId]);
    if (rows.length === 0) {
      throw new NotFoundApplicationError('WALLET_NOT_FOUND', `Wallet ${walletId} não encontrada`);
    }
    const row = rows[0];
    return {
      id: row.id,
      playerId: row.player_id,
      balance: {
        amount: Number(row.balance_amount).toFixed(2),
        currency: row.currency,
      },
      version: Number(row.version),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async getWalletLedger(walletId: string, cursor?: string, limit = 50) {
    await this.getWalletById(walletId); // Garante 404 se wallet não existir
    const conn = this.em.getConnection();
    const safeLimit = Math.min(Math.max(1, Number(limit) || 50), 200);

    let rows: any[];
    if (cursor) {
      let decoded: { createdAt: string; id: string };
      try {
        decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      } catch {
        decoded = { createdAt: new Date().toISOString(), id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
      }

      rows = await conn.execute<any[]>(
        `SELECT * FROM wallet_ledger_entries
         WHERE wallet_id = ?
           AND (created_at, id) < (?::timestamptz, ?::uuid)
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [walletId, decoded.createdAt, decoded.id, safeLimit + 1],
      );
    } else {
      rows = await conn.execute<any[]>(
        `SELECT * FROM wallet_ledger_entries
         WHERE wallet_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [walletId, safeLimit + 1],
      );
    }

    const hasNextPage = rows.length > safeLimit;
    const pageRows = hasNextPage ? rows.slice(0, safeLimit) : rows;
    const lastItem = pageRows[pageRows.length - 1];

    const nextCursor =
      hasNextPage && lastItem
        ? Buffer.from(
            JSON.stringify({
              createdAt: new Date(lastItem.created_at).toISOString(),
              id: lastItem.id,
            }),
            'utf8',
          ).toString('base64url')
        : null;

    return {
      items: pageRows.map((r) => ({
        id: r.id,
        walletId: r.wallet_id,
        transactionId: r.transaction_id,
        direction: r.direction,
        money: { amount: Number(r.money_amount).toFixed(2), currency: r.money_currency },
        balanceBefore: {
          amount: Number(r.balance_before_amount).toFixed(2),
          currency: r.money_currency,
        },
        balanceAfter: {
          amount: Number(r.balance_after_amount).toFixed(2),
          currency: r.money_currency,
        },
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor,
    };
  }

  async getTransactionById(transactionId: string) {
    const conn = this.em.getConnection();
    const rows = await conn.execute<any[]>(`SELECT * FROM wager_transactions WHERE id = ?`, [
      transactionId,
    ]);
    if (rows.length === 0) {
      throw new NotFoundApplicationError(
        'TRANSACTION_NOT_FOUND',
        `Transação ${transactionId} não encontrada`,
      );
    }
    return this.mapTransactionResponse(rows[0]);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string) {
    const conn = this.em.getConnection();
    const rows = await conn.execute<any[]>(
      `SELECT * FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    if (rows.length === 0) {
      throw new NotFoundApplicationError(
        'TRANSACTION_NOT_FOUND',
        `Transação ${providerId}:${externalTransactionId} não encontrada`,
      );
    }
    return this.mapTransactionResponse(rows[0]);
  }

  /**
   * Seção 9: Reconciliação entre saldo armazenado na wallet e soma algébrica do ledger.
   */
  async reconcileWallet(walletId: string) {
    const conn = this.em.getConnection();
    const walletRows = await conn.execute<any[]>(`SELECT * FROM wallets WHERE id = ?`, [walletId]);
    if (walletRows.length === 0) {
      throw new NotFoundApplicationError('WALLET_NOT_FOUND', `Wallet ${walletId} não encontrada`);
    }

    const walletRow = walletRows[0];
    const currency = walletRow.currency as string;
    const storedBalance = Money.from({
      amount: Number(walletRow.balance_amount).toFixed(2),
      currency,
    });

    const aggRows = await conn.execute<any[]>(
      `SELECT
         COUNT(*)::int AS checked_entries,
         COALESCE(
           SUM(CASE WHEN direction = 'CREDIT' THEN money_amount ELSE -money_amount END),
           0.00
         ) AS calculated_amount
       FROM wallet_ledger_entries
       WHERE wallet_id = ?`,
      [walletId],
    );

    const checkedEntries = Number(aggRows[0].checked_entries);
    const calculatedAmountStr = Number(aggRows[0].calculated_amount).toFixed(2);
    const calculatedBalance = Money.from({
      amount: calculatedAmountStr.startsWith('-') ? '0.00' : calculatedAmountStr,
      currency,
    });

    const consistent = storedBalance.equals(calculatedBalance);
    const diffDec = Math.abs(
      Number(storedBalance.toJSON().amount) - Number(calculatedAmountStr),
    ).toFixed(2);

    if (!consistent) {
      this.metrics.incrementReconciliationDiscrepancies();
      this.logger.error('WalletReconciliationDiscrepancyDetected', {
        walletId,
        storedBalance: storedBalance.toJSON().amount,
        calculatedBalance: calculatedAmountStr,
        difference: diffDec,
        checkedEntries,
      });
    }

    return {
      walletId,
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: { amount: calculatedAmountStr, currency },
      difference: { amount: diffDec, currency },
      consistent,
      checkedEntries,
    };
  }

  private mapTransactionResponse(row: any) {
    return {
      id: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind,
      status: row.status,
      money: { amount: Number(row.money_amount).toFixed(2), currency: row.money_currency },
      referenceExternalTransactionId: row.reference_external_transaction_id ?? null,
      referenceTransactionId: row.reference_transaction_id ?? null,
      failureCode: row.failure_code ?? null,
      balance:
        row.observed_balance_amount !== null && row.observed_balance_amount !== undefined
          ? { amount: Number(row.observed_balance_amount).toFixed(2), currency: row.money_currency }
          : null,
      createdAt: new Date(row.created_at).toISOString(),
      processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : null,
    };
  }
}