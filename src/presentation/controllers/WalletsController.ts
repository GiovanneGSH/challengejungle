import { Body, Controller, Get, Param, Post, Query, UseFilters } from '@nestjs/common';
import { CreateWalletUseCase } from '../../application/use-cases/CreateWalletUseCase';
import { WalletQueriesAndReconciliationUseCase } from '../../application/use-cases/WalletQueriesAndReconciliationUseCase';
import { DomainExceptionFilter } from '../filters/DomainExceptionFilter';
import { MoneyProps } from '../../domain/value-objects/Money';

@Controller('wallets')
@UseFilters(DomainExceptionFilter)
export class WalletsController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly queriesUseCase: WalletQueriesAndReconciliationUseCase,
  ) {}

  @Post()
  async createWallet(@Body() body: { playerId: string; initialBalance: MoneyProps }) {
    return this.createWalletUseCase.execute(body);
  }

  @Get(':walletId')
  async getWallet(@Param('walletId') walletId: string) {
    return this.queriesUseCase.getWalletById(walletId);
  }

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: number,
  ) {
    return this.queriesUseCase.getWalletLedger(walletId, cursor, limit ? Number(limit) : 50);
  }

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string) {
    return this.queriesUseCase.reconcileWallet(walletId);
  }
}