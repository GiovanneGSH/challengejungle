import { Body, Controller, Get, Headers, Param, Post, UseFilters } from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/ProcessWagerTransactionUseCase';
import { WalletQueriesAndReconciliationUseCase } from '../../application/use-cases/WalletQueriesAndReconciliationUseCase';
import { DomainExceptionFilter } from '../filters/DomainExceptionFilter';
import { WagerTransactionKind } from '../../domain/entities/WagerTransaction';
import { MoneyProps } from '../../domain/value-objects/Money';

@Controller()
@UseFilters(DomainExceptionFilter)
export class WageringController {
  constructor(
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly queriesUseCase: WalletQueriesAndReconciliationUseCase,
  ) {}

  @Post('wagering/transactions')
  async processWager(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body()
    body: {
      providerId: string;
      externalTransactionId: string;
      playerId: string;
      walletId: string;
      roundId: string;
      gameId: string;
      kind: WagerTransactionKind;
      money: MoneyProps;
      referenceExternalTransactionId?: string;
    },
  ) {
    return this.processWagerUseCase.execute({
      idempotencyKey,
      ...body,
    });
  }

  @Get('wagering/transactions/:transactionId')
  async getTransaction(@Param('transactionId') transactionId: string) {
    return this.queriesUseCase.getTransactionById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getTransactionByExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.queriesUseCase.getTransactionByExternalId(providerId, externalTransactionId);
  }
}