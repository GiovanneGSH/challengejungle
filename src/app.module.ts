import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { ScheduleModule } from '@nestjs/schedule';
import { buildMikroOrmConfig } from './infra/database/mikro-orm.config';
import { StructuredLogger } from './infra/observability/StructuredLogger';
import { MetricsService } from './infra/observability/MetricsService';
import { CreateWalletUseCase } from './application/use-cases/CreateWalletUseCase';
import { ProcessWagerTransactionUseCase } from './application/use-cases/ProcessWagerTransactionUseCase';
import { WalletQueriesAndReconciliationUseCase } from './application/use-cases/WalletQueriesAndReconciliationUseCase';
import { WalletsController } from './presentation/controllers/WalletsController';
import { WageringController } from './presentation/controllers/WageringController';
import { HealthController } from './presentation/controllers/HealthController';
import { PendingReferenceWorker } from './infra/messaging/PendingReferenceWorker';
import { OutboxPublisherWorker } from './infra/messaging/OutboxPublisherWorker';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    MikroOrmModule.forRoot(buildMikroOrmConfig()),
  ],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    StructuredLogger,
    MetricsService,
    CreateWalletUseCase,
    ProcessWagerTransactionUseCase,
    WalletQueriesAndReconciliationUseCase,
    PendingReferenceWorker,
    OutboxPublisherWorker,
  ],
})
export class AppModule {}