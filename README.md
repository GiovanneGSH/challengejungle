# Jungle Wagering Service 🦧

Serviço financeiro distribuído de alta concorrência para plataformas de iGaming, construído com foco em **correção financeira estrita**, **controle de concorrência pessimista**, **idempotência persistente**, **ledger imutável** e **padrões Transactional Outbox/Inbox**.

> Para detalhes aprofundados sobre decisões de design, trade-offs, concorrência e taxonomia de erros, consulte o arquivo [**ARCHITECTURE.md**](./ARCHITECTURE.md).

---

## 🛠️ Stack Tecnológica

- **Runtime & Test Runner:** [Bun 1.x](https://bun.sh/)
- **Linguagem:** TypeScript (`strict: true`)
- **Framework HTTP & DI:** NestJS
- **Banco de Dados:** PostgreSQL 16 (`NUMERIC(19, 2)`, Triggers & Advisory Locks)
- **ORM & Migrations:** MikroORM
- **Mensageria:** AWS SQS via LocalStack
- **Matemática Financeira:** `decimal.js`

---

## 🚀 Como Executar o Projeto

### Pré-requisitos

- [Bun](https://bun.sh/) instalado
- [Docker Desktop](https://www.docker.com/) em execução

### 1. Subir a Infraestrutura Local (PostgreSQL + LocalStack)

```powershell
docker compose up -d
```

### 2. Instalar as Dependências

```powershell
bun install
```

### 3. Executar as Migrations do Banco de Dados

```powershell
bun run migration:up
```

### 4. Executar a Suíte de Testes (Unidade + Concorrência Real)

Executa os 14 cenários automatizados, incluindo imutabilidade do ledger via trigger, apostas simultâneas concorrentes na mesma carteira e 50 requisições paralelas idempotentes:

```powershell
bun test
```

### 5. Verificar Tipagem Estrita

```powershell
bun run typecheck
```

### 6. Iniciar o Servidor HTTP

```powershell
bun run dev
```

O servidor iniciará em `http://localhost:3000`.

---

## 📋 Endpoints da API

### Health Checks

- `GET /health/live` — Liveness probe do processo.
- `GET /health/ready` — Readiness probe validando conectividade ativa com o PostgreSQL.

### Carteiras (`Wallets`)

- **`POST /wallets`** — Cria uma carteira com lançamento inicial (`OPENING`) no Ledger.

  **Exemplo de requisição:**

  ```json
  {
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": {
      "amount": "1000.00",
      "currency": "BRL"
    }
  }
  ```

- **`GET /wallets/:walletId`** — Consulta saldo atual, moeda e versão da carteira.

- **`GET /wallets/:walletId/ledger?cursor=...&limit=50`** — Lista o histórico imutável de lançamentos com paginação por cursor.

- **`POST /wallets/:walletId/reconciliation`** — Audita a carteira somando todos os créditos e débitos do Ledger e confrontando o resultado com o saldo atual.

### Transações de Apostas (`Wagering`)

- **`POST /wagering/transactions`**
  - **Header obrigatório:** `Idempotency-Key: <chave-unica>`
  - **Tipos suportados (`kind`):** `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`

  **Exemplo de requisição:**

  ```json
  {
    "providerId": "provider-a",
    "externalTransactionId": "tx-1001",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-500",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": {
      "amount": "25.00",
      "currency": "BRL"
    }
  }
  ```

- **`GET /wagering/transactions/:transactionId`** — Busca uma transação pelo ID interno.

- **`GET /providers/:providerId/wagering/transactions/:externalTransactionId`** — Busca uma transação pela chave composta do provedor.

---

## 📂 Estrutura de Diretórios

- `src/domain/` — Entidades puras, Value Objects (`Money`, `PayloadHasher`) e invariantes de negócio.
- `src/application/` — Casos de uso transacionais (`CreateWallet`, `ProcessWagerTransaction`, `Reconciliation`) e portas.
- `src/infra/` — Schemas MikroORM, Migrations SQL, Workers (`OutboxPublisher`, `PendingReference`) e Observabilidade.
- `src/presentation/` — Controllers NestJS e `DomainExceptionFilter`.
- `test/` — Suíte de testes unitários de domínio e testes de integração/concorrência no PostgreSQL.