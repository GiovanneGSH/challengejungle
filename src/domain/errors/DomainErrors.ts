export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  NegativeBalanceOnReversal = 'NEGATIVE_BALANCE_ON_REVERSAL',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletOwnershipMismatch = 'WALLET_OWNERSHIP_MISMATCH',
  ReferenceNotFoundTimeout = 'REFERENCE_NOT_FOUND_TIMEOUT',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  DuplicateReversal = 'DUPLICATE_REVERSAL',
  AmountMismatch = 'AMOUNT_MISMATCH',
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
}

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super(
      FailureCode.CurrencyMismatch,
      `Conflito de moeda: esperado ${expected}, recebido ${received}`,
    );
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super(FailureCode.InsufficientFunds, 'Saldo insuficiente na carteira');
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super('INVALID_TRANSACTION_STATE', message);
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(idempotencyKey: string) {
    super(
      'IDEMPOTENCY_KEY_CONFLICT',
      `A Idempotency-Key "${idempotencyKey}" já foi utilizada com um payload diferente`,
    );
  }
}