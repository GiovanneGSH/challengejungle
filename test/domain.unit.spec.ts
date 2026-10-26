import { describe, expect, it } from 'bun:test';
import { Money } from '../src/domain/value-objects/Money';
import { PayloadHasher } from '../src/domain/value-objects/PayloadHasher';
import { Wallet } from '../src/domain/entities/Wallet';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../src/domain/entities/WagerTransaction';
import { LedgerDirection } from '../src/domain/entities/WalletLedgerEntry';
import {
  CurrencyMismatchError,
  FailureCode,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidTransactionStateError,
} from '../src/domain/errors/DomainErrors';

describe('13. Testes Unitários Obrigatórios - Domínio', () => {
  describe('Money (Escala, Arredondamento, Entradas Inválidas e Moeda)', () => {
    it('deve criar Money válido e realizar soma e subtração exatas sem erro de ponto flutuante', () => {
      const a = Money.from({ amount: '0.10', currency: 'BRL' });
      const b = Money.from({ amount: '0.20', currency: 'BRL' });
      const sum = a.add(b);

      expect(sum.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
      expect(sum.subtract(a).equals(b)).toBe(true);
    });

    it('deve rejeitar NaN, Infinity, notação científica, string vazia, negativos e escala != 2 casas', () => {
      const invalidAmounts = ['NaN', 'Infinity', '1e5', '', '-10.00', '25', '25.0', '25.000', 'abc'];
      for (const amount of invalidAmounts) {
        expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
      }
    });

    it('deve lançar erro de domínio ao operar moedas diferentes', () => {
      const brl = Money.from({ amount: '50.00', currency: 'BRL' });
      const usd = Money.from({ amount: '50.00', currency: 'USD' });

      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
    });
  });

  describe('Wallet (Invariantes, Versionamento e Ledger)', () => {
    it('deve iniciar com version 1 e incrementar somente quando o saldo mudar, gerando Ledger balanceado', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      });

      expect(wallet.version).toBe(1);

      const debitEntry = wallet.debit({
        ledgerEntryId: 'ledger-1',
        transactionId: 'tx-1',
        money: Money.from({ amount: '40.00', currency: 'BRL' }),
      });

      expect(wallet.balance.toJSON().amount).toBe('60.00');
      expect(wallet.version).toBe(2);
      expect(debitEntry.direction).toBe(LedgerDirection.Debit);
      expect(debitEntry.isBalanced()).toBe(true);

      const creditEntry = wallet.credit({
        ledgerEntryId: 'ledger-2',
        transactionId: 'tx-2',
        money: Money.from({ amount: '15.00', currency: 'BRL' }),
      });

      expect(wallet.balance.toJSON().amount).toBe('75.00');
      expect(wallet.version).toBe(3);
      expect(creditEntry.direction).toBe(LedgerDirection.Credit);
      expect(creditEntry.isBalanced()).toBe(true);
    });

    it('não deve permitir saldo negativo em débito nem moeda divergente da wallet', () => {
      const wallet = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
      });

      expect(() =>
        wallet.debit({
          ledgerEntryId: 'ledger-1',
          transactionId: 'tx-1',
          money: Money.from({ amount: '50.01', currency: 'BRL' }),
        }),
      ).toThrow(InsufficientFundsError);

      expect(() =>
        wallet.credit({
          ledgerEntryId: 'ledger-2',
          transactionId: 'tx-2',
          money: Money.from({ amount: '10.00', currency: 'USD' }),
        }),
      ).toThrow(CurrencyMismatchError);

      expect(wallet.version).toBe(1);
    });
  });

  describe('WagerTransaction (Regras de BET, WIN, LOSS, REFUND, ROLLBACK e Estados Terminais)', () => {
    it('deve bloquear transições a partir de estados terminais (PROCESSED, REJECTED, FAILED)', () => {
      const tx = WagerTransaction.create({
        id: 'tx-1',
        providerId: 'prov-1',
        externalTransactionId: 'ext-1',
        idempotencyKey: 'prov-1:ext-1',
        payloadHash: 'hash-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
      });

      tx.markProcessed(undefined, new Date());
      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.isTerminal()).toBe(true);

      expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    });

    it('deve calcular a direção correta do Ledger para ROLLBACK conforme a transação referenciada', () => {
      const betTx = WagerTransaction.create({
        id: 'tx-bet',
        providerId: 'prov-1',
        externalTransactionId: 'ext-bet',
        idempotencyKey: 'prov-1:ext-bet',
        payloadHash: 'hash-bet',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
      });

      const winTx = WagerTransaction.create({
        id: 'tx-win',
        providerId: 'prov-1',
        externalTransactionId: 'ext-win',
        idempotencyKey: 'prov-1:ext-win',
        payloadHash: 'hash-win',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Win,
        money: Money.from({ amount: '50.00', currency: 'BRL' }),
      });

      const rollbackTx = WagerTransaction.create({
        id: 'tx-rb',
        providerId: 'prov-1',
        externalTransactionId: 'ext-rb',
        idempotencyKey: 'prov-1:ext-rb',
        payloadHash: 'hash-rb',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Rollback,
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        referenceExternalTransactionId: 'ext-bet',
      });

      expect(rollbackTx.ledgerDirectionFor(betTx)).toBe(LedgerDirection.Credit);
      expect(rollbackTx.ledgerDirectionFor(winTx)).toBe(LedgerDirection.Debit);
    });

    it('deve detectar conflito de payload para a mesma Idempotency-Key', () => {
      const basePayload = {
        providerId: 'provider-a',
        externalTransactionId: 'tx-100',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      };

      const hash1 = PayloadHasher.hashWagerPayload(basePayload);
      const hash2 = PayloadHasher.hashWagerPayload({
        ...basePayload,
        money: { amount: '30.00', currency: 'BRL' },
      });

      const tx = WagerTransaction.create({
        id: 'tx-id-1',
        ...basePayload,
        idempotencyKey: 'provider-a:tx-100',
        payloadHash: hash1,
        money: Money.from(basePayload.money),
      });

      expect(tx.matchesPayload(hash1)).toBe(true);
      expect(tx.matchesPayload(hash2)).toBe(false);
    });
  });
});