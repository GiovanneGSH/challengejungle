import { Injectable, Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { Money, MoneyProps } from '../../domain/value-objects/Money';
import { Wallet } from '../../domain/entities/Wallet';
import { WagerTransaction, WagerTransactionKind } from '../../domain/entities/WagerTransaction';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/entities/WalletLedgerEntry';
import { OutboxMessage } from '../../domain/entities/OutboxMessage';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '../../domain/events/IntegrationEvent';
import { PayloadHasher } from '../../domain/value-objects/PayloadHasher';
import { ConflictApplicationError } from '../ports/ProviderIdentityPort';
import { StructuredLogger } from '../../infra/observability/StructuredLogger';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletOutput> {
    const initialMoney = Money.from(input.initialBalance);
    const walletId = randomUUID();
    const correlationId = input.correlationId ?? randomUUID();
    const now = new Date();

    const wallet = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance: initialMoney,
      createdAt: now,
    });

    try {
      await this.em.transactional(async (txEm) => {
        await txEm.execute(
          `INSERT INTO wallets (id, player_id, currency, balance_amount, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            wallet.id,
            wallet.playerId,
            wallet.currency,
            wallet.balance.toJSON().amount,
            wallet.version,
            wallet.createdAt,
            wallet.updatedAt,
          ],
        );

        if (initialMoney.isPositive()) {
          const openingTxId = randomUUID();
          const idempotencyKey = `internal:opening:${wallet.id}`;
          const payloadHash = PayloadHasher.hashWagerPayload({
            providerId: 'internal-system',
            externalTransactionId: `opening-${wallet.id}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: `opening-round-${wallet.id}`,
            gameId: 'wallet-opening',
            kind: WagerTransactionKind.Opening,
            money: initialMoney.toJSON(),
          });

          const openingTx = WagerTransaction.create({
            id: openingTxId,
            providerId: 'internal-system',
            externalTransactionId: `opening-${wallet.id}`,
            idempotencyKey,
            payloadHash,
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: `opening-round-${wallet.id}`,
            gameId: 'wallet-opening',
            kind: WagerTransactionKind.Opening,
            money: initialMoney,
            createdAt: now,
            allowOpeningInternal: true,
          });

          openingTx.markProcessed(undefined, now, initialMoney);

          const ledgerEntry = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: openingTx.id,
            direction: LedgerDirection.Credit,
            money: initialMoney,
            balanceBefore: Money.zero(wallet.currency),
            balanceAfter: initialMoney,
            createdAt: now,
          });

          await txEm.execute(
            `INSERT INTO wager_transactions (
              id, provider_id, external_transaction_id, idempotency_key, payload_hash,
              wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
              status, observed_balance_amount, created_at, processed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              openingTx.id,
              openingTx.providerId,
              openingTx.externalTransactionId,
              openingTx.idempotencyKey,
              openingTx.payloadHash,
              openingTx.walletId,
              openingTx.playerId,
              openingTx.roundId,
              openingTx.gameId,
              openingTx.kind,
              openingTx.money.toJSON().amount,
              openingTx.money.currency,
              openingTx.status,
              initialMoney.toJSON().amount,
              openingTx.createdAt,
              openingTx.processedAt,
            ],
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

          const balanceEvent = OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, ledgerEntry, {
              eventId: randomUUID(),
              correlationId,
              occurredAt: now,
            }),
          );

          const processedEvent = OutboxMessage.enqueue(
            WagerTransactionProcessed.from(openingTx, {
              eventId: randomUUID(),
              correlationId,
              occurredAt: now,
            }),
          );

          for (const outboxMsg of [balanceEvent, processedEvent]) {
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
        }
      });
    } catch (err: any) {
      if (err?.code === '23505' || String(err?.message).includes('uq_wallets_player_currency')) {
        throw new ConflictApplicationError(
          'WALLET_ALREADY_EXISTS',
          `Já existe uma wallet para o playerId=${input.playerId} e moeda=${input.initialBalance.currency}`,
        );
      }
      throw err;
    }

    this.logger.info('WalletCreated', {
      correlationId,
      walletId: wallet.id,
      playerId: wallet.playerId,
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}