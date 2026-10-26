import { createHash } from 'crypto';
import { MoneyProps } from './Money';

export interface CanonicalWagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export class PayloadHasher {
  /**
   * Gera um hash SHA-256 determinístico ordenando as chaves do subconjunto de negócio.
   * Metadados de transporte e headers ficam de fora (Seção 9).
   */
  static hashWagerPayload(payload: CanonicalWagerPayload): string {
    const normalized = {
      externalTransactionId: payload.externalTransactionId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: {
        amount: payload.money.amount,
        currency: payload.money.currency,
      },
      playerId: payload.playerId,
      providerId: payload.providerId,
      referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
      roundId: payload.roundId,
      walletId: payload.walletId,
    };

    const canonicalJson = JSON.stringify(normalized);
    return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  }
}