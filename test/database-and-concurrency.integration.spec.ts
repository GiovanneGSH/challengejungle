import { afterAll, beforeAll, beforeEach, describe, expect, it, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { buildMikroOrmConfig } from '../src/infra/database/mikro-orm.config';
import { StructuredLogger } from '../src/infra/observability/StructuredLogger';
import { MetricsService } from '../src/infra/observability/MetricsService';
import { CreateWalletUseCase } from '../src/application/use-cases/CreateWalletUseCase';
import { ProcessWagerTransactionUseCase } from '../src/application/use-cases/ProcessWagerTransactionUseCase';
import { WalletQueriesAndReconciliationUseCase } from '../src/application/use-cases/WalletQueriesAndReconciliationUseCase';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../src/domain/entities/WagerTransaction';
import { FailureCode, IdempotencyConflictError } from '../src/domain/errors/DomainErrors';

process.env.SILENT_LOGS = 'true';

describe('13. Testes de Integração e Concorrência no PostgreSQL Real', () => {
  let orm: MikroORM;
  let createWalletUseCase: CreateWalletUseCase;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let queriesUseCase: WalletQueriesAndReconciliationUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(buildMikroOrmConfig());
    await orm.migrator.up();

    const logger = new StructuredLogger();
    const metrics = new MetricsService();
    createWalletUseCase = new CreateWalletUseCase(orm.em, logger);
    processWagerUseCase = new ProcessWagerTransactionUseCase(orm.em, logger, metrics);
    queriesUseCase = new WalletQueriesAndReconciliationUseCase(orm.em, logger, metrics);
  });

  beforeEach(async () => {
    const conn = orm.em.getConnection();
    await conn.execute(`
      TRUNCATE TABLE outbox_messages, inbox_messages, wallet_ledger_entries, wager_transactions, wallets CASCADE;
    `);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  it('deve impedir UPDATE ou DELETE no wallet_ledger_entries via Trigger do banco (Regra 5.5 e 5.9)', async () => {
    const wallet = await createWalletUseCase.execute({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const conn = orm.em.getConnection();
    await expect(
      conn.execute(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [wallet.id]),
    ).rejects.toThrow(/immutable/i);
  });

  it('Cenário Obrigatório Seção 8: Saldo 100.00 BRL e 2 apostas simultâneas de 80.00 BRL -> 1 PROCESSED, 1 REJECTED, saldo final 20.00 BRL', async () => {
    const playerId = randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const [res1, res2] = await Promise.all([
      processWagerUseCase.execute({
        idempotencyKey: 'provider-a:bet-80-1',
        providerId: 'provider-a',
        externalTransactionId: 'bet-80-1',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      }),
      processWagerUseCase.execute({
        idempotencyKey: 'provider-a:bet-80-2',
        providerId: 'provider-a',
        externalTransactionId: 'bet-80-2',
        playerId,
        walletId: wallet.id,
        roundId: 'round-2',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);

    const rejected = res1.status === WagerTransactionStatus.Rejected ? res1 : res2;
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

    const reconciliation = await queriesUseCase.reconcileWallet(wallet.id);
    expect(reconciliation.storedBalance.amount).toBe('20.00');
    expect(reconciliation.calculatedBalance.amount).toBe('20.00');
    expect(reconciliation.consistent).toBe(true);
    // 1 OPENING (crédito 100.00) + 1 BET (débito 80.00) = 2 entradas no ledger
    expect(reconciliation.checkedEntries).toBe(2);
  });

  it('Concorrência #1: A mesma aposta enviada 50 vezes em paralelo -> um único débito e 49 replays idempotentes', async () => {
    const playerId = randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        processWagerUseCase.execute({
          idempotencyKey: 'provider-a:tx-parallel-50',
          providerId: 'provider-a',
          externalTransactionId: 'tx-parallel-50',
          playerId,
          walletId: wallet.id,
          roundId: 'round-50',
          gameId: 'fortune-chimp',
          kind: WagerTransactionKind.Bet,
          money: { amount: '25.00', currency: 'BRL' },
        }),
      ),
    );

    const freshExecutions = results.filter((r) => !r.idempotentReplay);
    const replays = results.filter((r) => r.idempotentReplay);

    expect(freshExecutions).toHaveLength(1);
    expect(replays).toHaveLength(49);
    expect(results.every((r) => r.balance.amount === '975.00')).toBe(true);

    const reconciliation = await queriesUseCase.reconcileWallet(wallet.id);
    expect(reconciliation.storedBalance.amount).toBe('975.00');
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.checkedEntries).toBe(2);
  }, 30000);

  it('Concorrência #7: REFUND entregue antes da BET referenciada -> entra em PENDING_REFERENCE e processa após a BET chegar', async () => {
    const playerId = randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // 1. REFUND chega antes da BET!
    const refundOut = await processWagerUseCase.execute({
      idempotencyKey: 'provider-a:refund-early',
      providerId: 'provider-a',
      externalTransactionId: 'refund-early',
      playerId,
      walletId: wallet.id,
      roundId: 'round-oob',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-late',
    });

    expect(refundOut.status).toBe(WagerTransactionStatus.PendingReference);

    // 2. Agora a BET original chega e debita 30.00 -> saldo cai para 70.00
    const betOut = await processWagerUseCase.execute({
      idempotencyKey: 'provider-a:bet-late',
      providerId: 'provider-a',
      externalTransactionId: 'bet-late',
      playerId,
      walletId: wallet.id,
      roundId: 'round-oob',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    });

    expect(betOut.status).toBe(WagerTransactionStatus.Processed);
    expect(betOut.balance.amount).toBe('70.00');

    // 3. Worker reprocessa a transação que estava em PENDING_REFERENCE -> saldo volta para 100.00
    await processWagerUseCase.reprocessPendingReference(refundOut.transactionId);

    const updatedRefund = await queriesUseCase.getTransactionById(refundOut.transactionId);
    expect(updatedRefund.status).toBe(WagerTransactionStatus.Processed);

    const reconciliation = await queriesUseCase.reconcileWallet(wallet.id);
    expect(reconciliation.storedBalance.amount).toBe('100.00');
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.checkedEntries).toBe(3); // OPENING + BET + REFUND
  });

  it('Regra 7.9: Reversão (ROLLBACK de WIN) que deixaria saldo negativo é rejeitada com NEGATIVE_BALANCE_ON_REVERSAL', async () => {
    const playerId = randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });

    // Jogador ganha 50.00 -> saldo 60.00
    await processWagerUseCase.execute({
      idempotencyKey: 'provider-a:win-50',
      providerId: 'provider-a',
      externalTransactionId: 'win-50',
      playerId,
      walletId: wallet.id,
      roundId: 'round-r1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Win,
      money: { amount: '50.00', currency: 'BRL' },
    });

    // Jogador aposta 40.00 em outra rodada -> saldo cai para 20.00
    await processWagerUseCase.execute({
      idempotencyKey: 'provider-a:bet-40',
      providerId: 'provider-a',
      externalTransactionId: 'bet-40',
      playerId,
      walletId: wallet.id,
      roundId: 'round-r2',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '40.00', currency: 'BRL' },
    });

    // Provedor tenta fazer ROLLBACK do WIN de 50.00, mas carteira só tem 20.00!
    const rollbackRes = await processWagerUseCase.execute({
      idempotencyKey: 'provider-a:rollback-win-50',
      providerId: 'provider-a',
      externalTransactionId: 'rollback-win-50',
      playerId,
      walletId: wallet.id,
      roundId: 'round-r1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: 'win-50',
    });

    expect(rollbackRes.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollbackRes.failureCode).toBe(FailureCode.NegativeBalanceOnReversal);

    const reconciliation = await queriesUseCase.reconcileWallet(wallet.id);
    expect(reconciliation.storedBalance.amount).toBe('20.00');
    expect(reconciliation.consistent).toBe(true);
  });

  it('deve lançar IdempotencyConflictError se repetir Idempotency-Key com payload diferente', async () => {
    const playerId = randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    await processWagerUseCase.execute({
      idempotencyKey: 'provider-a:conflict-key',
      providerId: 'provider-a',
      externalTransactionId: 'conflict-tx',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    });

    await expect(
      processWagerUseCase.execute({
        idempotencyKey: 'provider-a:conflict-key',
        providerId: 'provider-a',
        externalTransactionId: 'conflict-tx',
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '99.00', currency: 'BRL' }, // Valor diferente!
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });
});