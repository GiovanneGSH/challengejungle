import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import {
  InboxMessageSchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  WalletSchema,
} from './schemas';
import { Migration202607290001_InitialSchema } from './migrations/Migration202607290001_InitialSchema';

export const buildMikroOrmConfig = () =>
  defineConfig({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'jungle',
    password: process.env.DB_PASSWORD ?? 'jungle_password',
    dbName: process.env.DB_NAME ?? 'jungle_ledger',
    entities: [
      WalletSchema,
      WagerTransactionSchema,
      WalletLedgerEntrySchema,
      InboxMessageSchema,
      OutboxMessageSchema,
    ],
    extensions: [Migrator],
    migrations: {
      migrationsList: [
        {
          name: 'Migration202607290001_InitialSchema',
          class: Migration202607290001_InitialSchema,
        },
      ],
    },
    pool: { min: 2, max: 100 },
    allowGlobalContext: true,
  });

export default buildMikroOrmConfig();