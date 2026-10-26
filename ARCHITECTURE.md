# Jungle Wagering Service — Architecture Decision Record (ADR)

Serviço financeiro distribuído de alta concorrência desenvolvido para plataformas de iGaming, focado em correção financeira estrita, concorrência distribuída, idempotência persistente e integridade transacional.

---

## 1. Arquitetura em Camadas e DDD (Seção 4)

O projeto adota **Domain-Driven Design (DDD)** e **Clean Architecture** com separação estrita entre regras de negócio e detalhes de infraestrutura:

- **`src/domain/` (Puro):** Entidades (`Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `OutboxMessage`, `InboxMessage`), Value Objects (`Money`, `PayloadHasher`) e erros de domínio. Zero acoplamento com NestJS, MikroORM ou bibliotecas externas de I/O.
- **`src/application/`:** Casos de uso transacionais (`CreateWalletUseCase`, `ProcessWagerTransactionUseCase`, `WalletQueriesAndReconciliationUseCase`) e portas de saída (`ProviderIdentityPort`).
- **`src/infra/`:** Schemas do MikroORM desacoplados (`EntitySchema`), migrations SQL nativas, workers assíncronos (`OutboxPublisherWorker`, `PendingReferenceWorker`) e serviços de observabilidade (`StructuredLogger`, `MetricsService`).
- **`src/presentation/`:** Controllers REST (`WalletsController`, `WageringController`, `HealthController`) e filtro global de exceções (`DomainExceptionFilter`).

---

## 2. Decisões Arquiteturais e Justificativas (Seção 14)

### 2.1 Representação Monetária Exata (Regra Inviolável 5.1)
- **Decisão:** Uso exclusivo de `decimal.js` em memória combinado com `NUMERIC(19, 2)` no PostgreSQL.
- **Justificativa:** Tipos IEEE 754 (`number`, `float`, `double`) introduzem desvios de arredondamento inaceitáveis em livros-razão financeiros. Toda aritmética é validada em string decimal exata com duas casas decimais antes de atingir o banco.

### 2.2 Estratégia de Concorrência Distribuída (Seção 8)
- **Decisão:** Combinação de **Pessimistic Write Lock (`SELECT ... FOR UPDATE`)** na linha da `Wallet` com **Transactional Advisory Locks (`pg_advisory_xact_lock`)** baseados no hash da chave de idempotência e da transação externa.
- **Justificativa:** 
  1. O lock pessimista por `walletId` serializa operações concorrentes na mesma carteira sem bloquear carteiras de outros jogadores (que processam em paralelo real).
  2. O `pg_advisory_xact_lock` serializa requisições idênticas que chegam simultaneamente no mesmo milissegundo (ex.: 50 envios paralelos da mesma aposta) antes mesmo do `INSERT`, evitando contenção de índices únicos e garantindo que 1 requisição processe e as 49 recebam o replay idempotente exato.

### 2.3 Idempotência Persistente e Hash Canônico (Seções 5.2 e 9)
- **Decisão:** Persistência obrigatória na tabela `wager_transactions` com constraints únicas para `idempotency_key` e `(provider_id, external_transaction_id)`, acompanhadas de `payload_hash` (SHA-256 de JSON ordenado canonicamente).
- **Justificativa:** O banco de dados atua como única fonte da verdade entre múltiplas instâncias. Se uma requisição repetida apresentar o mesmo `payload_hash`, o serviço retorna o resultado original gravado (incluindo o `observed_balance_amount` do momento exato da execução). Se o hash divergir para a mesma chave, retorna `409 Conflict` (`IDEMPOTENCY_KEY_CONFLICT`).

### 2.4 Imutabilidade do Ledger e Consistência Contábil (Seções 5.5 e 6.4)
- **Decisão:** Tabela `wallet_ledger_entries` protegida por `CHECK` constraints aritméticas (`balance_before +/- amount = balance_after`) e pelo Trigger PostgreSQL `trg_immutable_ledger` (`BEFORE UPDATE OR DELETE`), que lança exceção imediata no banco caso qualquer mutação seja tentada.
- **Justificativa:** O Ledger é um registro *append-only* de auditoria financeira. Nenhuma alteração de saldo na `Wallet` ocorre fora da transação ACID que insere a respectiva entrada no Ledger.

### 2.5 Referências Fora de Ordem (Seção 7)
- **Decisão:** Transações dependentes (`WIN`, `LOSS`, `REFUND`, `ROLLBACK`) cuja transação de referência (`BET`) ainda não chegou são persistidas com status `PENDING_REFERENCE` (`202 Accepted`) e reprocessadas assincronamente pelo `PendingReferenceWorker` com backoff exponencial.
- **Justificativa:** Em ambientes distribuídos de provedores de jogos, webhooks de resultado ou cancelamento podem chegar antes da confirmação da aposta original devido a retentativas de rede.

### 2.6 Transactional Outbox & Inbox Pattern (Seções 10 e 11)
- **Decisão:** Eventos de domínio (`OutboxMessage`) são gravados na mesma transação SQL da mudança de estado. O `OutboxPublisherWorker` faz polling usando `FOR UPDATE SKIP LOCKED` para despacho seguro entre múltiplas réplicas. Mensagens consumidas via SQS registram o `messageId` na tabela `inbox_messages` antes do ACK.
- **Justificativa:** Elimina o problema de *dual-write* entre PostgreSQL e AWS SQS, garantindo entrega *at-least-once* na publicação e processamento *effectively-once* no consumo.

### 2.7 Extensão de Autenticação (Seção 2)
- **Decisão:** Abstração via porta `ProviderIdentityPort` configurada para operação determinística nos testes locais, projetada para receber um adaptador OIDC/OAuth2 (Client Credentials via Keycloak/Zitadel) validando JWTs de provedores em produção.

---

## 3. Taxonomia de Códigos de Falha (`FailureCode`)

| Failure Code | Status HTTP | Cenário de Negócio |
| :--- | :--- | :--- |
| `INSUFFICIENT_FUNDS` | `422 Unprocessable Entity` | Saldo insuficiente na carteira para debitar uma aposta (`BET`). |
| `NEGATIVE_BALANCE_ON_REVERSAL` | `422 Unprocessable Entity` | Estorno de ganho (`ROLLBACK` de `WIN`) deixaria o saldo da carteira negativo. |
| `CURRENCY_MISMATCH` | `422 Unprocessable Entity` | Moeda informada na transação diverge da moeda configurada na carteira. |
| `WALLET_OWNERSHIP_MISMATCH` | `422 Unprocessable Entity` | `walletId` informado não pertence ao `playerId` da requisição. |
| `REFERENCE_NOT_FOUND` | `202 Accepted` | Transação referenciada ainda não existe; registrada como `PENDING_REFERENCE`. |
| `REFERENCE_NOT_PROCESSED` | `422 Unprocessable Entity` | Transação referenciada foi rejeitada anteriormente e não pode receber liquidacão/estorno. |
| `REFERENCE_MISMATCH` | `422 Unprocessable Entity` | A referência pertence a outro player, carteira, moeda ou provedor. |
| `INVALID_REFERENCE_KIND` | `422 Unprocessable Entity` | Tipo da referência incompatível com a operação (ex.: `REFUND` apontando para `WIN`). |
| `DUPLICATE_REVERSAL` | `422 Unprocessable Entity` | Tentativa de estornar ou reverter uma transação que já foi estornada anteriormente. |
| `IDEMPOTENCY_KEY_CONFLICT` | `409 Conflict` | Reuso da mesma `Idempotency-Key` ou `externalTransactionId` com payload divergente. |
