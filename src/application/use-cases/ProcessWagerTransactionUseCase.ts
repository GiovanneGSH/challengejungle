import { Injectable, Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { Money, MoneyProps } from '../../domain/value-objects/Money';
import { PayloadHasher } from '../../domain/value-objects/PayloadHasher';
import { Wallet } from '../../domain/entities/Wallet';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/WagerTransaction';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/entities/WalletLedgerEntry';
import { InboxMessage } from '../../domain/entities/InboxMessage';
import { OutboxMessage } from '../../domain/entities/OutboxMessage';
import {
  IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/IntegrationEvent';
import {
  DomainError,
  FailureCode,
  IdempotencyConflictError,
  InsufficientFundsError,
} from '../../domain/errors/DomainErrors';
import { NotFoundApplicationError } from '../ports/ProviderIdentityPort';
import { StructuredLogger } from '../../infra/observability/StructuredLogger';
import { MetricsService } from '../../infra/observability/MetricsService';

export interface ProcessWagerInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  inboxContext?: {
    consumerName: string;
    messageId: string;
  };
}

export interface ProcessWagerOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async execute(input: ProcessWagerInput): Promise<ProcessWagerOutput> {
    const startedAt = performance.now();
    const correlationId = input.correlationId ?? randomUUID();

    if (!input.idempotencyKey || input.idempotencyKey.trim() === '') {
      throw new DomainError('MISSING_IDEMPOTENCY_KEY', 'O header Idempotency-Key é obrigatório');
    }

    if (input.kind === WagerTransactionKind.Opening) {
      throw new DomainError('FORBIDDEN_OPENING_KIND', 'OPENING não pode ser submetido externamente');
    }

    const money = Money.from(input.money);
    const payloadHash = PayloadHasher.hashWagerPayload({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });

    const candidateTx = WagerTransaction.create({
      id: randomUUID(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });

    try {
      const result = await this.em.transactional(async (txEm) => {
        const now = new Date();

        await txEm.execute(`SELECT pg_advisory_xact_lock(hashtext(?))`, [input.idempotencyKey]);
        await txEm.execute(`SELECT pg_advisory_xact_lock(hashtext(?))`, [
          `${input.providerId}:${input.externalTransactionId}`,
        ]);

        let inboxMsg: InboxMessage | undefined;
        if (input.inboxContext) {
          const existingInboxRows = (await txEm.execute(
            `SELECT * FROM inbox_messages WHERE consumer_name = ? AND message_id = ? FOR UPDATE`,
            [input.inboxContext.consumerName, input.inboxContext.messageId],
          )) as any[];

          if (existingInboxRows.length > 0 && existingInboxRows[0].processed_at) {
            this.metrics.incrementDuplicates();
            const existingTxRows = (await txEm.execute(
              `SELECT * FROM wager_transactions WHERE idempotency_key = ?`,
              [input.idempotencyKey],
            )) as any[];
            if (existingTxRows.length > 0) {
              const row = existingTxRows[0];
              return {
                transactionId: row.id,
                status: row.status as WagerTransactionStatus,
                balance: {
                  amount: Number(row.observed_balance_amount ?? 0).toFixed(2),
                  currency: row.money_currency,
                },
                idempotentReplay: true,
                ...(row.failure_code ? { failureCode: row.failure_code as FailureCode } : {}),
              };
            }
          }

          inboxMsg = InboxMessage.receive({
            consumerName: input.inboxContext.consumerName,
            messageId: input.inboxContext.messageId,
            payloadHash,
            receivedAt: now,
          });
        }

        const existingRows = (await txEm.execute(
          `SELECT * FROM wager_transactions
           WHERE idempotency_key = ? OR (provider_id = ? AND external_transaction_id = ?)
           LIMIT 1`,
          [input.idempotencyKey, input.providerId, input.externalTransactionId],
        )) as any[];

        if (existingRows.length > 0) {
          const existingRow = existingRows[0];
          const existingTx = this.rehydrateTransaction(existingRow);

          if (
            existingTx.idempotencyKey !== input.idempotencyKey ||
            !existingTx.matchesPayload(payloadHash)
          ) {
            throw new IdempotencyConflictError(input.idempotencyKey);
          }

          this.metrics.incrementDuplicates();
          if (inboxMsg) {
            inboxMsg.markProcessed(now);
            await this.UpsertInbox(txEm, inboxMsg);
          }

          this.logger.info('WagerTransactionIdempotentReplay', {
            correlationId,
            transactionId: existingTx.id,
            walletId: existingTx.walletId,
            providerId: existingTx.providerId,
          });

          return {
            transactionId: existingTx.id,
            status: existingTx.status,
            balance: existingTx.observedBalance
              ? existingTx.observedBalance.toJSON()
              : { amount: '0.00', currency: existingTx.money.currency },
            idempotentReplay: true,
            ...(existingTx.failureCode ? { failureCode: existingTx.failureCode } : {}),
          };
        }

        const walletRows = (await txEm.execute(
          `SELECT * FROM wallets WHERE id = ? FOR UPDATE`,
          [input.walletId],
        )) as any[];

        if (walletRows.length === 0) {
          throw new NotFoundApplicationError(
            'WALLET_NOT_FOUND',
            `Wallet ${input.walletId} não encontrada`,
          );
        }

        const wallet = this.rehydrateWallet(walletRows[0]);

        const { ledgerEntry, outboxEvents } = await this.applyBusinessRules(
          txEm,
          wallet,
          candidateTx,
          correlationId,
          now,
        );

        if (ledgerEntry) {
          await txEm.execute(
            `UPDATE wallets
             SET balance_amount = ?, version = ?, updated_at = ?
             WHERE id = ?`,
            [
              wallet.balance.toJSON().amount,
              wallet.version,
              wallet.updatedAt,
              wallet.id,
            ],
          );
        }

        const nextRetryAt =
          candidateTx.status === WagerTransactionStatus.PendingReference
            ? new Date(now.getTime() + 500)
            : null;

        await txEm.execute(
          `INSERT INTO wager_transactions (
            id, provider_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
            reference_external_transaction_id, reference_transaction_id,
            status, failure_code, observed_balance_amount, retry_count, next_retry_at,
            created_at, processed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            candidateTx.id,
            candidateTx.providerId,
            candidateTx.externalTransactionId,
            candidateTx.idempotencyKey,
            candidateTx.payloadHash,
            candidateTx.walletId,
            candidateTx.playerId,
            candidateTx.roundId,
            candidateTx.gameId,
            candidateTx.kind,
            candidateTx.money.toJSON().amount,
            candidateTx.money.currency,
            candidateTx.referenceExternalTransactionId ?? null,
            candidateTx.referenceTransactionId ?? null,
            candidateTx.status,
            candidateTx.failureCode ?? null,
            wallet.balance.toJSON().amount,
            0,
            nextRetryAt,
            candidateTx.createdAt,
            candidateTx.processedAt ?? null,
          ],
        );

        if (ledgerEntry) {
          await txEm.execute(
            `INSERT INTO wallet_ledger_entries (
              id, wallet_id, transaction_id, direction, money_amount, money_currency,
              balance_before_amount, balance_after_amount, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              ledgerEntry.id,
              ledgerEntry.walletId,
              ledgerEntry.transactionId,
              ledgerEntry.direction,
              ledgerEntry.money.toJSON().amount,
              ledgerEntry.money.currency,
              ledgerEntry.balanceBefore.toJSON().amount,
              ledgerEntry.balanceAfter.toJSON().amount,
              ledgerEntry.createdAt,
            ],
          );
        }

        for (const event of outboxEvents) {
          const outboxMsg = OutboxMessage.enqueue(event);
          await txEm.execute(
            `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
             VALUES (?, ?, ?, ?::jsonb, ?, ?)`,
            [
              outboxMsg.id,
              outboxMsg.aggregateId,
              outboxMsg.eventType,
              JSON.stringify(outboxMsg.payload),
              outboxMsg.occurredAt,
              outboxMsg.attempts,
            ],
          );
        }

        if (inboxMsg) {
          inboxMsg.markProcessed(now);
          await this.UpsertInbox(txEm, inboxMsg);
        }

        this.metrics.incrementTransactionStatus(candidateTx.status);

        this.logger.info('WagerTransactionHandled', {
          correlationId,
          messageId: input.inboxContext?.messageId,
          transactionId: candidateTx.id,
          walletId: wallet.id,
          providerId: candidateTx.providerId,
          kind: candidateTx.kind,
          status: candidateTx.status,
          failureCode: candidateTx.failureCode ?? null,
        });

        return {
          transactionId: candidateTx.id,
          status: candidateTx.status,
          balance: wallet.balance.toJSON(),
          idempotentReplay: false,
          ...(candidateTx.failureCode ? { failureCode: candidateTx.failureCode } : {}),
        };
      });

      return result;
    } catch (err: any) {
      if (
        err?.code === '23505' ||
        String(err?.message).includes('uq_wager_idempotency_key') ||
        String(err?.message).includes('uq_wager_provider_external_id')
      ) {
        this.metrics.incrementDuplicates();
        const conn = this.em.getConnection();
        const existingRows = (await conn.execute(
          `SELECT * FROM wager_transactions WHERE idempotency_key = ? OR (provider_id = ? AND external_transaction_id = ?) LIMIT 1`,
          [input.idempotencyKey, input.providerId, input.externalTransactionId],
        )) as any[];

        if (existingRows.length > 0) {
          const row = existingRows[0];
          this.logger.info('WagerTransactionIdempotentReplayOnConstraintRace', {
            correlationId,
            transactionId: row.id,
            idempotencyKey: input.idempotencyKey,
          });

          return {
            transactionId: row.id,
            status: row.status as WagerTransactionStatus,
            balance: {
              amount: Number(row.observed_balance_amount ?? 0).toFixed(2),
              currency: row.money_currency,
            },
            idempotentReplay: true,
            ...(row.failure_code ? { failureCode: row.failure_code as FailureCode } : {}),
          };
        }
      }
      throw err;
    } finally {
      this.metrics.recordLatencyMs(performance.now() - startedAt);
    }
  }

  async reprocessPendingReference(transactionId: string, maxRetries = 5): Promise<void> {
    await this.em.transactional(async (txEm) => {
      const now = new Date();

      const txRows = (await txEm.execute(
        `SELECT * FROM wager_transactions
         WHERE id = ? AND status = 'PENDING_REFERENCE'
         FOR UPDATE SKIP LOCKED`,
        [transactionId],
      )) as any[];
      if (txRows.length === 0) return;

      const row = txRows[0];
      const tx = this.rehydrateTransaction(row);

      const walletRows = (await txEm.execute(
        `SELECT * FROM wallets WHERE id = ? FOR UPDATE`,
        [tx.walletId],
      )) as any[];
      if (walletRows.length === 0) return;
      const wallet = this.rehydrateWallet(walletRows[0]);

      const { ledgerEntry, outboxEvents } = await this.applyBusinessRules(
        txEm,
        wallet,
        tx,
        randomUUID(),
        now,
      );

      if (tx.status === WagerTransactionStatus.PendingReference) {
        const nextRetryCount = Number(row.retry_count) + 1;
        this.metrics.incrementRetries();

        if (nextRetryCount >= maxRetries) {
          tx.reject(FailureCode.ReferenceNotFoundTimeout, now, wallet.balance);
          const rejectedEvent = OutboxMessage.enqueue(
            WagerTransactionRejected.from(tx, {
              eventId: randomUUID(),
              correlationId: randomUUID(),
              occurredAt: now,
            }),
          );

          await txEm.execute(
            `UPDATE wager_transactions
             SET status = ?, failure_code = ?, observed_balance_amount = ?, retry_count = ?, processed_at = ?
             WHERE id = ?`,
            [
              tx.status,
              tx.failureCode,
              wallet.balance.toJSON().amount,
              nextRetryCount,
              now,
              tx.id,
            ],
          );

          await txEm.execute(
            `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
             VALUES (?, ?, ?, ?::jsonb, ?, ?)`,
            [
              rejectedEvent.id,
              rejectedEvent.aggregateId,
              rejectedEvent.eventType,
              JSON.stringify(rejectedEvent.payload),
              rejectedEvent.occurredAt,
              0,
            ],
          );
          this.metrics.incrementTransactionStatus(tx.status);
        } else {
          const backoffMs = Math.pow(2, nextRetryCount) * 300;
          const nextRetryAt = new Date(now.getTime() + backoffMs);
          await txEm.execute(
            `UPDATE wager_transactions SET retry_count = ?, next_retry_at = ? WHERE id = ?`,
            [nextRetryCount, nextRetryAt, tx.id],
          );
        }
        return;
      }

      if (ledgerEntry) {
        await txEm.execute(
          `UPDATE wallets SET balance_amount = ?, version = ?, updated_at = ? WHERE id = ?`,
          [wallet.balance.toJSON().amount, wallet.version, wallet.updatedAt, wallet.id],
        );

        await txEm.execute(
          `INSERT INTO wallet_ledger_entries (
            id, wallet_id, transaction_id, direction, money_amount, money_currency,
            balance_before_amount, balance_after_amount, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ledgerEntry.id,
            ledgerEntry.walletId,
            ledgerEntry.transactionId,
            ledgerEntry.direction,
            ledgerEntry.money.toJSON().amount,
            ledgerEntry.money.currency,
            ledgerEntry.balanceBefore.toJSON().amount,
            ledgerEntry.balanceAfter.toJSON().amount,
            ledgerEntry.createdAt,
          ],
        );
      }

      await txEm.execute(
        `UPDATE wager_transactions
         SET status = ?, reference_transaction_id = ?, failure_code = ?, observed_balance_amount = ?, processed_at = ?
         WHERE id = ?`,
        [
          tx.status,
          tx.referenceTransactionId ?? null,
          tx.failureCode ?? null,
          wallet.balance.toJSON().amount,
          tx.processedAt ?? now,
          tx.id,
        ],
      );

      for (const event of outboxEvents) {
        if (event.eventType === 'WagerTransactionPendingReference') continue;
        const outboxMsg = OutboxMessage.enqueue(event);
        await txEm.execute(
          `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts)
           VALUES (?, ?, ?, ?::jsonb, ?, ?)`,
          [
            outboxMsg.id,
            outboxMsg.aggregateId,
            outboxMsg.eventType,
            JSON.stringify(outboxMsg.payload),
            outboxMsg.occurredAt,
            outboxMsg.attempts,
          ],
        );
      }

      this.metrics.incrementTransactionStatus(tx.status);
    });
  }

  private async applyBusinessRules(
    txEm: any,
    wallet: Wallet,
    tx: WagerTransaction,
    correlationId: string,
    now: Date,
  ): Promise<{
    ledgerEntry?: WalletLedgerEntry;
    outboxEvents: IntegrationEvent<unknown>[];
  }> {
    const outboxEvents: IntegrationEvent<unknown>[] = [];

    if (wallet.playerId !== tx.playerId) {
      tx.reject(FailureCode.WalletOwnershipMismatch, now, wallet.balance);
      outboxEvents.push(
        WagerTransactionRejected.from(tx, { eventId: randomUUID(), correlationId, occurredAt: now }),
      );
      return { outboxEvents };
    }

    if (wallet.currency !== tx.money.currency) {
      tx.reject(FailureCode.CurrencyMismatch, now, wallet.balance);
      outboxEvents.push(
        WagerTransactionRejected.from(tx, { eventId: randomUUID(), correlationId, occurredAt: now }),
      );
      return { outboxEvents };
    }

    let referenceTx: WagerTransaction | undefined;
    if (tx.requiresReference() || tx.referenceExternalTransactionId) {
      const refRows = (await txEm.execute(
        `SELECT * FROM wager_transactions
         WHERE provider_id = ? AND external_transaction_id = ?
         LIMIT 1`,
        [tx.providerId, tx.referenceExternalTransactionId],
      )) as any[];

      if (refRows.length === 0 || refRows[0].status === WagerTransactionStatus.PendingReference) {
        tx.markPendingReference();
        outboxEvents.push(
          WagerTransactionPendingReference.from(tx, {
            eventId: randomUUID(),
            correlationId,
            occurredAt: now,
          }),
        );
        return { outboxEvents };
      }

      referenceTx = this.rehydrateTransaction(refRows[0]);

      if (
        referenceTx.providerId !== tx.providerId ||
        referenceTx.playerId !== tx.playerId ||
        referenceTx.walletId !== tx.walletId ||
        referenceTx.money.currency !== tx.money.currency ||
        referenceTx.roundId !== tx.roundId
      ) {
        tx.reject(FailureCode.ReferenceMismatch, now, wallet.balance);
        outboxEvents.push(
          WagerTransactionRejected.from(tx, { eventId: randomUUID(), correlationId, occurredAt: now }),
        );
        return { outboxEvents };
      }

      if (referenceTx.status !== WagerTransactionStatus.Processed) {
        tx.reject(FailureCode.ReferenceNotProcessed, now, wallet.balance);
        outboxEvents.push(
          WagerTransactionRejected.from(tx, { eventId: randomUUID(), correlationId, occurredAt: now }),
        );
        return { outboxEvents };
      }

      if (tx.requiresReference()) {
        if (
          tx.kind === WagerTransactionKind.Refund &&
          referenceTx.kind !== WagerTransactionKind.Bet
        ) {
          tx.reject(FailureCode.InvalidReferenceKind, now, wallet.balance);
          outboxEvents.push(
            WagerTransactionRejected.from(tx, { eventId: randomUUID(), correlationId, occurredAt: now }),
          );
          return { outboxEvents };
        }

        if (
          tx.kind === WagerTransactionKind.Rollback &&
          ![
            WagerTransactionKind.Bet,
            WagerTransactionKind.Win,
            WagerTransactionKind.Refund,
          ].includes(referenceTx.kind)
        ) {
          tx.reject(FailureCode.InvalidReferenceKind, now, wallet.balance);
          outboxEvents.push(
            WagerTransactionRejected.from(tx, { eventId: randomUUID(), correlationId, occurredAt: now }),
          );
          return { outboxEvents };
        }

        if (!tx.money.equals(referenceTx.money)) {
          tx.reject(FailureCode.AmountMismatch, now, wallet.balance);
          outboxEvents.push(
            WagerTransactionRejected.from(tx, { eventId: randomUUID(), correlationId, occurredAt: now }),
          );
          return { outboxEvents };
        }

        const existingReversalRows = (await txEm.execute(
          `SELECT id FROM wager_transactions
           WHERE reference_transaction_id = ?
             AND status = 'PROCESSED'
             AND kind IN ('REFUND', 'ROLLBACK')
           LIMIT 1`,
          [referenceTx.id],
        )) as any[];

        if (existingReversalRows.length > 0) {
          tx.reject(FailureCode.DuplicateReversal, now, wallet.balance);
          outboxEvents.push(
            WagerTransactionRejected.from(tx, { eventId: randomUUID(), correlationId, occurredAt: now }),
          );
          return { outboxEvents };
        }
      } else if (tx.kind === WagerTransactionKind.Win) {
        if (referenceTx.kind !== WagerTransactionKind.Bet) {
          tx.reject(FailureCode.InvalidReferenceKind, now, wallet.balance);
          outboxEvents.push(
            WagerTransactionRejected.from(tx, { eventId: randomUUID(), correlationId, occurredAt: now }),
          );
          return { outboxEvents };
        }
      }
    }

    let ledgerEntry: WalletLedgerEntry | undefined;

    if (tx.kind === WagerTransactionKind.Loss) {
      tx.markProcessed(referenceTx?.id, now, wallet.balance);
      outboxEvents.push(
        WagerTransactionProcessed.from(tx, { eventId: randomUUID(), correlationId, occurredAt: now }),
      );
      return { outboxEvents };
    }

    const direction = tx.ledgerDirectionFor(referenceTx);

    try {
      if (direction === LedgerDirection.Debit) {
        ledgerEntry = wallet.debit({
          ledgerEntryId: randomUUID(),
          transactionId: tx.id,
          money: tx.money,
          at: now,
        });
      } else {
        ledgerEntry = wallet.credit({
          ledgerEntryId: randomUUID(),
          transactionId: tx.id,
          money: tx.money,
          at: now,
        });
      }
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        const failureCode =
          tx.kind === WagerTransactionKind.Rollback
            ? FailureCode.NegativeBalanceOnReversal
            : FailureCode.InsufficientFunds;

        tx.reject(failureCode, now, wallet.balance);
        outboxEvents.push(
          WagerTransactionRejected.from(tx, { eventId: randomUUID(), correlationId, occurredAt: now }),
        );
        return { outboxEvents };
      }
      throw err;
    }

    tx.markProcessed(referenceTx?.id, now, wallet.balance);

    outboxEvents.push(
      WalletBalanceChanged.from(wallet, ledgerEntry, {
        eventId: randomUUID(),
        correlationId,
        occurredAt: now,
      }),
      WagerTransactionProcessed.from(tx, {
        eventId: randomUUID(),
        correlationId,
        occurredAt: now,
      }),
    );

    return { ledgerEntry, outboxEvents };
  }

  private async UpsertInbox(txEm: any, inbox: InboxMessage): Promise<void> {
    await txEm.execute(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id)
       DO UPDATE SET processed_at = EXCLUDED.processed_at`,
      [
        inbox.consumerName,
        inbox.messageId,
        inbox.payloadHash,
        inbox.receivedAt,
        inbox.processedAt ?? null,
      ],
    );
  }

  private rehydrateWallet(row: any): Wallet {
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.player_id,
      currency: row.currency,
      balance: Money.from({
        amount: Number(row.balance_amount).toFixed(2),
        currency: row.currency,
      }),
      version: Number(row.version),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  }

  private rehydrateTransaction(row: any): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id,
      idempotencyKey: row.idempotency_key,
      payloadHash: row.payload_hash,
      walletId: row.wallet_id,
      playerId: row.player_id,
      roundId: row.round_id,
      gameId: row.game_id,
      kind: row.kind as WagerTransactionKind,
      money: Money.from({
        amount: Number(row.money_amount).toFixed(2),
        currency: row.money_currency,
      }),
      referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
      createdAt: new Date(row.created_at),
      status: row.status as WagerTransactionStatus,
      referenceTransactionId: row.reference_transaction_id ?? undefined,
      failureCode: (row.failure_code as FailureCode) ?? undefined,
      processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
      observedBalance:
        row.observed_balance_amount !== null && row.observed_balance_amount !== undefined
          ? Money.from({
              amount: Number(row.observed_balance_amount).toFixed(2),
              currency: row.money_currency,
            })
          : undefined,
    });
  }
}