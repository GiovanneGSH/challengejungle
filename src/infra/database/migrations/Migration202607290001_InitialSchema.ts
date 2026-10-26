import { Migration } from '@mikro-orm/migrations';

export class Migration202607290001_InitialSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance_amount NUMERIC(19, 2) NOT NULL CHECK (balance_amount >= 0),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
      );

      CREATE TABLE IF NOT EXISTS wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(100) NOT NULL,
        external_transaction_id VARCHAR(150) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id UUID NOT NULL,
        round_id VARCHAR(150) NOT NULL,
        game_id VARCHAR(150) NOT NULL,
        kind VARCHAR(30) NOT NULL CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        money_amount NUMERIC(19, 2) NOT NULL CHECK (money_amount >= 0),
        money_currency VARCHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(150),
        reference_transaction_id UUID REFERENCES wager_transactions(id),
        status VARCHAR(30) NOT NULL CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code VARCHAR(80),
        observed_balance_amount NUMERIC(19, 2),
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        CONSTRAINT uq_wager_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_provider_external_id UNIQUE (provider_id, external_transaction_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_single_processed_reversal
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');

      CREATE INDEX IF NOT EXISTS idx_wager_pending_ref
        ON wager_transactions (next_retry_at)
        WHERE status = 'PENDING_REFERENCE';

      CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        transaction_id UUID NOT NULL UNIQUE REFERENCES wager_transactions(id),
        direction VARCHAR(10) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        money_amount NUMERIC(19, 2) NOT NULL CHECK (money_amount > 0),
        money_currency VARCHAR(3) NOT NULL,
        balance_before_amount NUMERIC(19, 2) NOT NULL CHECK (balance_before_amount >= 0),
        balance_after_amount NUMERIC(19, 2) NOT NULL CHECK (balance_after_amount >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_before_amount + money_amount = balance_after_amount) OR
          (direction = 'DEBIT'  AND balance_before_amount - money_amount = balance_after_amount)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_ledger_wallet_cursor
        ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);

      CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Ledger entries are strictly immutable and cannot be updated or deleted';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_immutable_ledger ON wallet_ledger_entries;
      CREATE TRIGGER trg_immutable_ledger
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

      CREATE TABLE IF NOT EXISTS inbox_messages (
        consumer_name VARCHAR(100) NOT NULL,
        message_id VARCHAR(150) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        PRIMARY KEY (consumer_name, message_id)
      );

      CREATE TABLE IF NOT EXISTS outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id VARCHAR(150) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
        ON outbox_messages (occurred_at ASC)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TABLE IF EXISTS outbox_messages CASCADE;
      DROP TABLE IF EXISTS inbox_messages CASCADE;
      DROP TRIGGER IF EXISTS trg_immutable_ledger ON wallet_ledger_entries;
      DROP FUNCTION IF EXISTS prevent_ledger_mutation();
      DROP TABLE IF EXISTS wallet_ledger_entries CASCADE;
      DROP TABLE IF EXISTS wager_transactions CASCADE;
      DROP TABLE IF EXISTS wallets CASCADE;
    `);
  }
}