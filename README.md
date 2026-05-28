# Floor Markets Indexer

Envio-powered blockchain indexer for the Floor Markets DeFi platform. Indexes bonding curve markets, credit facilities, presales, staking, and treasury events.

## Tech Stack

- **[Envio](https://envio.dev)** - High-performance blockchain indexer
- **Node.js 18+** - Runtime
- **pnpm** - Package manager
- **Docker** - Database infrastructure
- **TypeScript** - Type-safe handlers
- **GraphQL** - Query interface

## Project Structure

```
indexer/
├── abis/                    # Contract ABIs
├── config.yaml              # Envio configuration
├── schema.graphql           # GraphQL schema
├── src/
│   ├── index.ts             # Handler exports
│   ├── factory-handlers.ts  # Factory events
│   ├── market-handlers.ts   # Buy/Sell/Floor events
│   ├── credit-handlers.ts   # Loan events
│   ├── presale-handlers.ts  # Presale events
│   ├── treasury-handlers.ts # Fee distribution events
│   ├── staking-handlers.ts  # Staking events
│   ├── authorizer-handlers.ts # Role/permission events
│   ├── rpc-client.ts        # Viem RPC client
│   └── helpers/             # Shared utilities
├── generated/               # Auto-generated Envio types
├── test/                    # Handler tests
└── scripts/
    └── select_rpc.sh        # RPC selector script
```

## Prerequisites

- [Node.js v18+](https://nodejs.org/en/download/current)
- [pnpm v8+](https://pnpm.io/installation)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

## Quick Start

```bash
# Install dependencies
pnpm install

# Start the indexer (interactive RPC selection)
pnpm dev
```

Visit http://localhost:8080 to access the GraphQL Playground (password: `testing`).

## Commands

| Command         | Description                                      |
| --------------- | ------------------------------------------------ |
| `pnpm dev`      | Start indexer in development mode                |
| `pnpm codegen`  | Regenerate types from config.yaml/schema.graphql |
| `pnpm start`    | Start indexer in production mode                 |
| `pnpm test`     | Run handler tests                                |
| `pnpm db-up`    | Start database containers                        |
| `pnpm db-down`  | Stop database containers                         |
| `pnpm db-setup` | Reset and setup database                         |
| `pnpm build`    | Compile TypeScript                               |
| `pnpm lint`     | Lint and fix TypeScript files                    |

## Configuration

### RPC Selection

The indexer supports both local and remote RPC endpoints. When running `pnpm dev`, you'll be prompted to select:

```
Select RPC source ([l]ocal/[r]emote, default remote):
```

Alternatively, set environment variables:

```bash
# Use local Anvil
RPC_SOURCE=local pnpm dev

# Use remote devnet
RPC_SOURCE=remote pnpm dev

# Override RPC URL directly
RPC_URL_31337=http://127.0.0.1:8545 pnpm dev
```

### Environment Variables

| Variable        | Description                           | Default           |
| --------------- | ------------------------------------- | ----------------- |
| `RPC_URL_31337` | RPC endpoint for network 31337        | Remote devnet URL |
| `RPC_SOURCE`    | `local` or `remote`                   | `remote`          |
| `FLOOR_FACTORY` | FloorFactory contract address         | From config.yaml  |
| `LOG_LEVEL`     | Console log level                     | `trace`           |
| `LOG_STRATEGY`  | Log format (`console-pretty`, `json`) | `console-pretty`  |
| `TUI_OFF`       | Disable terminal UI for plain logs    | `true`            |

### Updating Contract Addresses

Edit `config.yaml` under the `networks` section:

```yaml
networks:
  - id: 31337
    start_block: 86594000
    contracts:
      - name: FloorFactory
        address: '0x...'
      - name: ModuleFactory
        address: '0x...'
      # Dynamic discovery for remaining contracts
      - name: FloorMarket
        address:
```

> **Note**: FloorFactory and ModuleFactory require explicit addresses. Other contracts (FloorMarket, CreditFacility, etc.) are discovered dynamically from factory events.

## Development Workflow

### 1. Schema Changes

After modifying `schema.graphql`:

```bash
# Regenerate Envio types
pnpm codegen

# Compile GraphQL SDK (from project root)
bun indexer:compile
```

### 2. Handler Changes

After modifying event handlers in `src/`:

```bash
# Restart the indexer
pnpm dev
```

### 3. Adding New Events

1. Add event to contract in `config.yaml`
2. Add handler in appropriate `*-handlers.ts` file
3. Export handler from `src/index.ts`
4. Run `pnpm codegen`

### 4. Clean Restart

For a fresh re-index from the configured start block:

```bash
# Remove persisted state
rm -f generated/persisted_state.envio.json

# Restart database
pnpm db-down && pnpm db-up

# Start indexer
pnpm dev
```

## Indexed Entities

### Core Entities

- **Market** - Bonding curve markets with price, supply, and fee data
- **Trade** - Buy/sell transactions
- **FloorElevation** - Floor price increase events
- **Loan** - Credit facility loans
- **Stake** - Staking positions
- **PresaleParticipation** - Presale deposits

### Registry Entities

- **GlobalRegistry** - Factory addresses
- **ModuleRegistry** - Per-market module addresses
- **Account** - User accounts with positions

### Historical Data

- **MarketSnapshot** - Periodic market state snapshots
- **PriceCandle** - OHLCV price candles (1h, 4h, 1d)
- **GlobalStats** / **GlobalStatsSnapshot** - Platform-wide metrics

## GraphQL Queries

Example queries for the GraphQL Playground:

```graphql
# Get all markets
query Markets {
  Market {
    id
    currentPriceFormatted
    floorPriceFormatted
    totalSupplyFormatted
    status
  }
}

# Get recent trades
query RecentTrades {
  Trade(order_by: { timestamp: desc }, limit: 20) {
    id
    tradeType
    tokenAmountFormatted
    reserveAmountFormatted
    timestamp
  }
}

# Get user positions
query UserPositions($userId: ID!) {
  UserMarketPosition(where: { user_id: { _eq: $userId } }) {
    market_id
    netFTokenChangeFormatted
    totalDebtFormatted
    stakedAmountFormatted
  }
}
```

## Debugging

### Enable Debug Logs

```bash
LOG_LEVEL=debug LOG_STRATEGY=console-pretty TUI_OFF=true pnpm dev
```

### Check Handler Invocations

All handlers log on entry:

```typescript
context.log.info(`TokensBought handler called: market=${event.srcAddress}`)
```

### Common Issues

| Issue              | Solution                                                         |
| ------------------ | ---------------------------------------------------------------- |
| Port 8080 in use   | Stop other Docker containers or use `pnpm db-down`               |
| No events indexed  | Check contract addresses in config.yaml                          |
| Stale data         | Delete `generated/persisted_state.envio.json`                    |
| Handler not called | Verify event is listed in config.yaml and exported from index.ts |

## Related Documentation

- [Envio Documentation](https://docs.envio.dev)
- [Handler Implementation Spec](./spec/handler-implementation-specification.md)
- [Data Group Architecture](./spec/data-group-architecture.md)
- [Debugging Guide](./spec/LOG_ANALYSIS.md)
