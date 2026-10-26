import { EntitySchema } from '@mikro-orm/core';

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  moneyAmount!: string;
  moneyCurrency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  observedBalanceAmount?: string | null;
  retryCount!: number;
  nextRetryAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export class WalletLedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  moneyAmount!: string;
  moneyCurrency!: string;
  balanceBeforeAmount!: string;
  balanceAfterAmount!: string;
  createdAt!: Date;
}

export class InboxMessageRecord {
  messageId!: string;
  consumerName!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', length: 3 },
    balanceAmount: { type: 'numeric', precision: 19, scale: 2, fieldName: 'balance_amount' },
    version: { type: 'integer', default: 1 },
    createdAt: { type: 'Date', fieldName: 'created_at' },
    updatedAt: { type: 'Date', fieldName: 'updated_at' },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', length: 100, fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', length: 150, fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', length: 255, fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', length: 64, fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', length: 150, fieldName: 'round_id' },
    gameId: { type: 'string', length: 150, fieldName: 'game_id' },
    kind: { type: 'string', length: 30 },
    moneyAmount: { type: 'numeric', precision: 19, scale: 2, fieldName: 'money_amount' },
    moneyCurrency: { type: 'string', length: 3, fieldName: 'money_currency' },
    referenceExternalTransactionId: {
      type: 'string',
      length: 150,
      nullable: true,
      fieldName: 'reference_external_transaction_id',
    },
    referenceTransactionId: {
      type: 'uuid',
      nullable: true,
      fieldName: 'reference_transaction_id',
    },
    status: { type: 'string', length: 30 },
    failureCode: { type: 'string', length: 80, nullable: true, fieldName: 'failure_code' },
    observedBalanceAmount: {
      type: 'numeric',
      precision: 19,
      scale: 2,
      nullable: true,
      fieldName: 'observed_balance_amount',
    },
    retryCount: { type: 'integer', default: 0, fieldName: 'retry_count' },
    nextRetryAt: { type: 'Date', nullable: true, fieldName: 'next_retry_at' },
    createdAt: { type: 'Date', fieldName: 'created_at' },
    processedAt: { type: 'Date', nullable: true, fieldName: 'processed_at' },
  },
});

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string', length: 10 },
    moneyAmount: { type: 'numeric', precision: 19, scale: 2, fieldName: 'money_amount' },
    moneyCurrency: { type: 'string', length: 3, fieldName: 'money_currency' },
    balanceBeforeAmount: {
      type: 'numeric',
      precision: 19,
      scale: 2,
      fieldName: 'balance_before_amount',
    },
    balanceAfterAmount: {
      type: 'numeric',
      precision: 19,
      scale: 2,
      fieldName: 'balance_after_amount',
    },
    createdAt: { type: 'Date', fieldName: 'created_at' },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', length: 100, primary: true, fieldName: 'consumer_name' },
    messageId: { type: 'string', length: 150, primary: true, fieldName: 'message_id' },
    payloadHash: { type: 'string', length: 64, fieldName: 'payload_hash' },
    receivedAt: { type: 'Date', fieldName: 'received_at' },
    processedAt: { type: 'Date', nullable: true, fieldName: 'processed_at' },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string', length: 150, fieldName: 'aggregate_id' },
    eventType: { type: 'string', length: 100, fieldName: 'event_type' },
    payload: { type: 'json' },
    occurredAt: { type: 'Date', fieldName: 'occurred_at' },
    attempts: { type: 'integer', default: 0 },
    nextAttemptAt: { type: 'Date', nullable: true, fieldName: 'next_attempt_at' },
    publishedAt: { type: 'Date', nullable: true, fieldName: 'published_at' },
  },
});
