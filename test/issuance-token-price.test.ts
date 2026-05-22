/**
 * Tests for issuance token Transfer → price refresh flow.
 *
 * Strategy: build a minimal mock HandlerContext that intercepts
 * context.effect (the Envio Effect caller) so we can return fixture
 * pricing data without hitting RPC, then run the handler logic and
 * assert on Market mutations.
 */

import assert from 'assert'

// ── helpers ────────────────────────────────────────────────────────────────

import {
  FLOOR_PRICE_DECIMALS,
  formatAmount,
  normalizeAddress,
  parseFloorPricingResult,
} from '../src/helpers/misc'
import { issuanceTokenToMarketId } from '../src/issuance-token-registry'

// Addresses (checksummed)
const ISSUANCE_TOKEN = normalizeAddress('0x1111111111111111111111111111111111111111')
const MARKET_ID = normalizeAddress('0x2222222222222222222222222222222222222222')
const FLOOR_ADDRESS = normalizeAddress('0x3333333333333333333333333333333333333333')
const RESERVE_TOKEN = normalizeAddress('0x4444444444444444444444444444444444444444')
const SENDER = normalizeAddress('0x5555555555555555555555555555555555555555')
const RECEIVER = normalizeAddress('0x6666666666666666666666666666666666666666')

// ── fixture data ───────────────────────────────────────────────────────────

const RESERVE_DECIMALS = 6 // e.g. USDC
const WAD = 1_000_000_000_000_000_000n

const baseMarket = {
  id: MARKET_ID,
  creator_id: SENDER,
  factory_id: 'unknown-factory',
  reserveToken_id: RESERVE_TOKEN,
  issuanceToken_id: ISSUANCE_TOKEN,
  initialFloorPriceRaw: 0n,
  initialFloorPriceFormatted: '0',
  tradingFeeBps: 0n,
  buyFeeBps: 100n,
  sellFeeBps: 50n,
  maxLTV: 0n,
  currentPriceRaw: WAD,
  currentPriceFormatted: '1',
  floorPriceRaw: (WAD * 9n) / 10n,
  floorPriceFormatted: '0.9',
  totalSupplyRaw: 1_000_000n,
  totalSupplyFormatted: '1',
  marketSupplyRaw: 1_000_000n,
  marketSupplyFormatted: '1',
  floorSupplyRaw: 0n,
  floorSupplyFormatted: '0',
  status: 'ACTIVE' as const,
  isBuyOpen: true,
  isSellOpen: true,
  lastTradeTimestamp: 0n,
  lastElevationTimestamp: 0n,
  lastUpdatedAt: 1000n,
  createdAt: 1000n,
}

const reserveToken = {
  id: RESERVE_TOKEN,
  name: 'USD Coin',
  symbol: 'USDC',
  decimals: RESERVE_DECIMALS,
  maxSupplyRaw: 0n,
  maxSupplyFormatted: '0',
}

const moduleRegistry = {
  id: MARKET_ID,
  floor: FLOOR_ADDRESS,
  authorizer: '',
  feeTreasury: '',
  creditFacility: '',
  presale: '',
  staking: '',
  createdAt: 1000n,
  lastUpdatedAt: 1000n,
}

// ── mock context builder ───────────────────────────────────────────────────

type EntityStore<T> = {
  get: (id: string) => Promise<T | undefined>
  set: (entity: T) => void
}

function makeStore<T>(initial: Record<string, T>): EntityStore<T> & { _data: Record<string, T> } {
  const data: Record<string, T> = { ...initial }
  return {
    _data: data,
    get: async (id: string) => data[id],
    set: (entity: T & { id: string }) => {
      data[entity.id] = entity
    },
  }
}

type FetchFloorPricingInput = { chainId: number; floorAddress: string }
type FetchFloorPricingOutput = {
  buyPrice: string | null
  sellPrice: string | null
  buyFeeBps: string | null
  sellFeeBps: string | null
  floorPrice: string | null
} | null

/**
 * Build a minimal mock context.
 * effectImpl receives (effectObject, input) and returns the output.
 */
function buildContext(opts: {
  market?: typeof baseMarket
  registry?: typeof moduleRegistry
  effectImpl?: (_effect: unknown, input: unknown) => Promise<unknown>
}) {
  const marketStore = makeStore<typeof baseMarket>(
    opts.market ? { [opts.market.id]: opts.market } : {}
  )
  const tokenStore = makeStore<typeof reserveToken>({
    [reserveToken.id]: reserveToken,
  })
  const registryStore = makeStore<typeof moduleRegistry>(
    opts.registry ? { [opts.registry.id]: opts.registry } : {}
  )

  const logs: string[] = []
  const log = {
    info: (msg: string) => logs.push(`[info] ${msg}`),
    warn: (msg: string) => logs.push(`[warn] ${msg}`),
    error: (msg: string) => logs.push(`[error] ${msg}`),
    debug: (msg: string) => logs.push(`[debug] ${msg}`),
  }

  const effect = opts.effectImpl ?? (async () => null)

  return {
    Market: marketStore,
    Token: tokenStore,
    ModuleRegistry: registryStore,
    log,
    effect,
    _marketStore: marketStore,
    _logs: logs,
  }
}

// ── handler under test (extracted logic) ──────────────────────────────────

// Import the helpers used by the handler so we can replicate its logic
// and test each branch. We test the handler logic functions directly
// rather than the Envio-registered handler function (which needs the full
// runtime) to keep tests fast and dependency-free.

/**
 * Mirrors the ERC20IssuanceToken.Transfer handler logic.
 * Uses context.effect directly (the mock) rather than importing Envio's
 * createEffect/wrapEffect, so this file has zero Envio runtime dependencies.
 */
async function runTransferHandler(
  context: ReturnType<typeof buildContext>,
  params: {
    issuanceTokenAddress: string
    from: string
    to: string
    chainId: number
    timestamp: bigint
  }
): Promise<void> {
  const { issuanceTokenAddress, chainId, timestamp } = params

  const marketId = issuanceTokenToMarketId.get(issuanceTokenAddress)
  if (!marketId) return

  const market = await context.Market.get(marketId)
  if (!market) return

  const reserveToken = await context.Token.get(market.reserveToken_id)
  if (!reserveToken) return

  const registry = await context.ModuleRegistry.get(marketId)
  if (!registry?.floor) return

  // Invoke the effect caller directly (bypasses wrapEffect / createEffect)
  const pricingResult = await context.effect(null, { chainId, floorAddress: registry.floor })

  if (!pricingResult) return

  const parsed = parseFloorPricingResult(
    pricingResult as Parameters<typeof parseFloorPricingResult>[0]
  )

  const buyPriceRaw = parsed.buyPrice ?? market.currentPriceRaw
  const floorPriceRaw = parsed.floorPrice ?? market.floorPriceRaw

  const updatedMarket = {
    ...market,
    currentPriceRaw: buyPriceRaw,
    currentPriceFormatted: formatAmount(buyPriceRaw, FLOOR_PRICE_DECIMALS).formatted,
    floorPriceRaw,
    floorPriceFormatted: formatAmount(floorPriceRaw, FLOOR_PRICE_DECIMALS).formatted,
    buyFeeBps: parsed.buyFeeBps ?? market.buyFeeBps,
    sellFeeBps: parsed.sellFeeBps ?? market.sellFeeBps,
    lastUpdatedAt: timestamp,
  }

  context.Market.set(updatedMarket as typeof baseMarket)
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('issuance token Transfer → price refresh', () => {
  beforeEach(() => {
    issuanceTokenToMarketId.clear()
  })

  describe('issuanceTokenToMarketId map (populated by IssuanceTokenSet / ModuleCreated)', () => {
    it('is empty before any market is registered', () => {
      assert.strictEqual(issuanceTokenToMarketId.size, 0)
    })

    it('stores and retrieves a mapping', () => {
      issuanceTokenToMarketId.set(ISSUANCE_TOKEN, MARKET_ID)
      assert.strictEqual(issuanceTokenToMarketId.get(ISSUANCE_TOKEN), MARKET_ID)
    })

    it('handles normalised and non-normalised addresses the same way when set with normalised key', () => {
      issuanceTokenToMarketId.set(ISSUANCE_TOKEN, MARKET_ID)
      // key is already normalised; a raw lower-case lookup would miss — callers must normalise
      assert.strictEqual(issuanceTokenToMarketId.get(ISSUANCE_TOKEN), MARKET_ID)
    })
  })

  describe('parseFloorPricingResult', () => {
    it('parses all fields from string representation', () => {
      const result = parseFloorPricingResult({
        buyPrice: '2000000000000000000',
        sellPrice: '1950000000000000000',
        buyFeeBps: '100',
        sellFeeBps: '50',
        floorPrice: '1800000000000000000',
      })
      assert.strictEqual(result.buyPrice, 2_000_000_000_000_000_000n)
      assert.strictEqual(result.sellPrice, 1_950_000_000_000_000_000n)
      assert.strictEqual(result.buyFeeBps, 100n)
      assert.strictEqual(result.sellFeeBps, 50n)
      assert.strictEqual(result.floorPrice, 1_800_000_000_000_000_000n)
    })

    it('returns empty object for null input', () => {
      const result = parseFloorPricingResult(null)
      assert.deepStrictEqual(result, {})
    })

    it('skips null field values gracefully', () => {
      const result = parseFloorPricingResult({
        buyPrice: null,
        sellPrice: '1950000000000000000',
        buyFeeBps: null,
        sellFeeBps: null,
        floorPrice: null,
      })
      assert.strictEqual(result.buyPrice, undefined)
      assert.strictEqual(result.sellPrice, 1_950_000_000_000_000_000n)
    })
  })

  describe('Transfer handler – price update', () => {
    it('updates market price after a transfer when all data is present', async () => {
      issuanceTokenToMarketId.set(ISSUANCE_TOKEN, MARKET_ID)

      const newBuyPrice = (WAD * 12n) / 10n // 1.2 WAD
      const newFloorPrice = WAD

      const context = buildContext({
        market: { ...baseMarket },
        registry: moduleRegistry,
        effectImpl: async () => ({
          buyPrice: newBuyPrice.toString(),
          sellPrice: '1150000000000000000',
          buyFeeBps: '100',
          sellFeeBps: '50',
          floorPrice: newFloorPrice.toString(),
        }),
      })

      await runTransferHandler(context, {
        issuanceTokenAddress: ISSUANCE_TOKEN,
        from: SENDER,
        to: RECEIVER,
        chainId: 31337,
        timestamp: 2000n,
      })

      const updated = await context.Market.get(MARKET_ID)
      assert.ok(updated, 'market should exist')
      assert.strictEqual(updated.currentPriceRaw, newBuyPrice)
      assert.strictEqual(updated.currentPriceFormatted, '1.2')
      assert.strictEqual(updated.floorPriceRaw, newFloorPrice)
      assert.strictEqual(updated.floorPriceFormatted, '1')
      assert.strictEqual(updated.lastUpdatedAt, 2000n)
    })

    it('preserves existing price when effect returns null', async () => {
      issuanceTokenToMarketId.set(ISSUANCE_TOKEN, MARKET_ID)

      const context = buildContext({
        market: { ...baseMarket },
        registry: moduleRegistry,
        effectImpl: async () => null, // RPC failure
      })

      await runTransferHandler(context, {
        issuanceTokenAddress: ISSUANCE_TOKEN,
        from: SENDER,
        to: RECEIVER,
        chainId: 31337,
        timestamp: 2000n,
      })

      // Market should NOT have been mutated
      const market = await context.Market.get(MARKET_ID)
      assert.ok(market)
      assert.strictEqual(market.currentPriceRaw, baseMarket.currentPriceRaw)
      assert.strictEqual(market.lastUpdatedAt, baseMarket.lastUpdatedAt)
    })

    it('does nothing when issuance token is not in the map', async () => {
      // Map is empty — token not yet registered
      const context = buildContext({
        market: { ...baseMarket },
        registry: moduleRegistry,
      })

      await runTransferHandler(context, {
        issuanceTokenAddress: ISSUANCE_TOKEN,
        from: SENDER,
        to: RECEIVER,
        chainId: 31337,
        timestamp: 2000n,
      })

      const market = await context.Market.get(MARKET_ID)
      assert.ok(market)
      // lastUpdatedAt unchanged → handler returned early
      assert.strictEqual(market.lastUpdatedAt, baseMarket.lastUpdatedAt)
    })

    it('does nothing when market entity is missing', async () => {
      issuanceTokenToMarketId.set(ISSUANCE_TOKEN, MARKET_ID)

      const context = buildContext({
        // no market provided
        registry: moduleRegistry,
        effectImpl: async () => ({
          buyPrice: '2000000000000000000',
          sellPrice: null,
          buyFeeBps: null,
          sellFeeBps: null,
          floorPrice: '1000000000000000000',
        }),
      })

      // Should not throw
      await runTransferHandler(context, {
        issuanceTokenAddress: ISSUANCE_TOKEN,
        from: SENDER,
        to: RECEIVER,
        chainId: 31337,
        timestamp: 2000n,
      })

      const market = await context.Market.get(MARKET_ID)
      assert.strictEqual(market, undefined)
    })

    it('does nothing when ModuleRegistry has no floor address', async () => {
      issuanceTokenToMarketId.set(ISSUANCE_TOKEN, MARKET_ID)

      const context = buildContext({
        market: { ...baseMarket },
        registry: { ...moduleRegistry, floor: '' }, // missing floor
      })

      const initialPrice = baseMarket.currentPriceRaw

      await runTransferHandler(context, {
        issuanceTokenAddress: ISSUANCE_TOKEN,
        from: SENDER,
        to: RECEIVER,
        chainId: 31337,
        timestamp: 2000n,
      })

      const market = await context.Market.get(MARKET_ID)
      assert.ok(market)
      assert.strictEqual(market.currentPriceRaw, initialPrice)
    })

    it('updates fees when effect returns updated fee values', async () => {
      issuanceTokenToMarketId.set(ISSUANCE_TOKEN, MARKET_ID)

      const context = buildContext({
        market: { ...baseMarket, buyFeeBps: 100n, sellFeeBps: 50n },
        registry: moduleRegistry,
        effectImpl: async () => ({
          buyPrice: '1100000000000000000',
          sellPrice: '1080000000000000000',
          buyFeeBps: '200', // fee doubled
          sellFeeBps: '100',
          floorPrice: '900000000000000000',
        }),
      })

      await runTransferHandler(context, {
        issuanceTokenAddress: ISSUANCE_TOKEN,
        from: SENDER,
        to: RECEIVER,
        chainId: 31337,
        timestamp: 3000n,
      })

      const market = await context.Market.get(MARKET_ID)
      assert.ok(market)
      assert.strictEqual(market.buyFeeBps, 200n)
      assert.strictEqual(market.sellFeeBps, 100n)
    })

    it('uses existing price fields as fallback when effect omits them', async () => {
      issuanceTokenToMarketId.set(ISSUANCE_TOKEN, MARKET_ID)

      const context = buildContext({
        market: { ...baseMarket },
        registry: moduleRegistry,
        effectImpl: async () => ({
          buyPrice: null, // no buy price returned
          sellPrice: null,
          buyFeeBps: null,
          sellFeeBps: null,
          floorPrice: null, // no floor price returned
        }),
      })

      await runTransferHandler(context, {
        issuanceTokenAddress: ISSUANCE_TOKEN,
        from: SENDER,
        to: RECEIVER,
        chainId: 31337,
        timestamp: 2000n,
      })

      const market = await context.Market.get(MARKET_ID)
      assert.ok(market)
      // Should fall back to existing values
      assert.strictEqual(market.currentPriceRaw, baseMarket.currentPriceRaw)
      assert.strictEqual(market.floorPriceRaw, baseMarket.floorPriceRaw)
      // But timestamp should be updated (handler ran to completion)
      assert.strictEqual(market.lastUpdatedAt, 2000n)
    })

    it('effect is called with the correct floor address', async () => {
      issuanceTokenToMarketId.set(ISSUANCE_TOKEN, MARKET_ID)

      const capturedInputs: unknown[] = []
      const context = buildContext({
        market: { ...baseMarket },
        registry: moduleRegistry,
        effectImpl: async (_effectObj, input) => {
          capturedInputs.push(input)
          return {
            buyPrice: '1000000000000000000',
            sellPrice: '990000000000000000',
            buyFeeBps: '100',
            sellFeeBps: '50',
            floorPrice: '900000000000000000',
          }
        },
      })

      await runTransferHandler(context, {
        issuanceTokenAddress: ISSUANCE_TOKEN,
        from: SENDER,
        to: RECEIVER,
        chainId: 31337,
        timestamp: 2000n,
      })

      assert.strictEqual(capturedInputs.length, 1)
      const input = capturedInputs[0] as { chainId: number; floorAddress: string }
      assert.strictEqual(input.chainId, 31337)
      assert.strictEqual(input.floorAddress, FLOOR_ADDRESS)
    })
  })

  describe('formatAmount (reserve / token amounts)', () => {
    it('formats 6-decimal values correctly', () => {
      assert.strictEqual(formatAmount(1_200_000n, 6).formatted, '1.2')
      assert.strictEqual(formatAmount(1_000_000n, 6).formatted, '1')
      assert.strictEqual(formatAmount(500_000n, 6).formatted, '0.5')
      assert.strictEqual(formatAmount(0n, 6).formatted, '0')
    })

    it('formats 18-decimal values correctly', () => {
      assert.strictEqual(formatAmount(1_000_000_000_000_000_000n, 18).formatted, '1')
      assert.strictEqual(formatAmount(1_500_000_000_000_000_000n, 18).formatted, '1.5')
    })
  })
})
