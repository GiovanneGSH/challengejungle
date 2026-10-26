import { CurrencyMismatchError, DomainError, InsufficientFundsError } from '../errors/DomainErrors';
import { Money } from '../value-objects/Money';
import { LedgerDirection, WalletLedgerEntry } from './WalletLedgerEntry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementParams {
  ledgerEntryId: string;
  transactionId: string;
  money: Money;
  at?: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    createdAt?: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new DomainError('NEGATIVE_INITIAL_BALANCE', 'Saldo inicial não pode ser negativo');
    }
    const now = props.createdAt ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1, // version inicia em 1 após a criação (Seção 6.2)
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Aplica débito garantindo saldo não-negativo, incremento de version
   * e geração obrigatória do WalletLedgerEntry correspondente.
   */
  debit(params: WalletMovementParams): WalletLedgerEntry {
    this.assertSameCurrency(params.money);

    if (this._balance.isLessThan(params.money)) {
      throw new InsufficientFundsError();
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(params.money);
    const now = params.at ?? new Date();

    const entry = WalletLedgerEntry.create({
      id: params.ledgerEntryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Debit,
      money: params.money,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return entry;
  }

  /**
   * Aplica crédito mantendo saldo, version e WalletLedgerEntry consistentes.
   */
  credit(params: WalletMovementParams): WalletLedgerEntry {
    this.assertSameCurrency(params.money);

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(params.money);
    const now = params.at ?? new Date();

    const entry = WalletLedgerEntry.create({
      id: params.ledgerEntryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Credit,
      money: params.money,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}