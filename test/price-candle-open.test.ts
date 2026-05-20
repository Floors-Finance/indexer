/**
 * Tests for updatePriceCandles candle-open semantics.
 *
 * Regression: a new candle's `open` is the *pre-trade* price (i.e. the
 * previous candle's close), not the post-trade price. Using the post-trade
 * price as open produces a synthetic vertical jump at every bucket boundary
 * on the chart because the previous candle closed at a different value.
 */

import assert from 'assert'

import { updatePriceCandles } from '../src/helpers/time'

type CandleRecord = {
  id: string
  market_id: string
  period: 'ONE_HOUR' | 'FOUR_HOURS' | 'ONE_DAY'
  timestamp: bigint
  openRaw: bigint
  openFormatted: string
  highRaw: bigint
  highFormatted: string
  lowRaw: bigint
  lowFormatted: string
  closeRaw: bigint
  closeFormatted: string
  volumeRaw: bigint
  volumeFormatted: string
  trades: bigint
}

function makeContext() {
  const store = new Map<string, CandleRecord>()
  const logs: string[] = []
  return {
    store,
    logs,
    context: {
      PriceCandle: {
        get: async (id: string) => store.get(id),
        set: (entity: CandleRecord) => {
          store.set(entity.id, entity)
        },
      },
      log: {
        info: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
        error: (m: string) => logs.push(m),
        debug: (m: string) => logs.push(m),
      },
    },
  }
}

const MARKET = '0x2222222222222222222222222222222222222222'
const RESERVE_DECIMALS = 6 // USDC-like

// 1.0 USDC = 1_000_000 at 6 decimals
const P_10 = 10_000_000n // 10.0
const P_12 = 12_000_000n // 12.0
const P_15 = 15_000_000n // 15.0
const P_8 = 8_000_000n // 8.0

// Trade happens at second 100 → ONE_HOUR bucket 0 (timestamp 0).
const T_FIRST = 100n
// Trade happens at second 4000 → ONE_HOUR bucket 3600.
const T_SECOND_BUCKET = 4000n

describe('updatePriceCandles - candle open semantics', () => {
  it('uses preTradePriceRaw as the candle open (price rises)', async () => {
    const { store, context } = makeContext()
    await updatePriceCandles(
      context as never,
      MARKET,
      {
        newPriceRaw: P_12,
        newPriceFormatted: '12',
        preTradePriceRaw: P_10,
        preTradePriceFormatted: '10',
        reserveAmountRaw: 1_000_000n,
        reserveAmountFormatted: '1',
        timestamp: T_FIRST,
      },
      'ONE_HOUR',
      RESERVE_DECIMALS
    )

    const candle = store.get(`${MARKET}-ONE_HOUR-0`)
    assert.ok(candle, 'candle should exist')
    assert.strictEqual(candle!.openRaw, P_10, 'open is the pre-trade price')
    assert.strictEqual(candle!.closeRaw, P_12, 'close is the post-trade price')
    assert.strictEqual(candle!.highRaw, P_12, 'high is max(pre, post)')
    assert.strictEqual(candle!.lowRaw, P_10, 'low is min(pre, post)')
    assert.strictEqual(candle!.openFormatted, '10')
    assert.strictEqual(candle!.closeFormatted, '12')
  })

  it('uses preTradePriceRaw as the candle open (price falls)', async () => {
    const { store, context } = makeContext()
    await updatePriceCandles(
      context as never,
      MARKET,
      {
        newPriceRaw: P_8,
        newPriceFormatted: '8',
        preTradePriceRaw: P_10,
        preTradePriceFormatted: '10',
        reserveAmountRaw: 1_000_000n,
        reserveAmountFormatted: '1',
        timestamp: T_FIRST,
      },
      'ONE_HOUR',
      RESERVE_DECIMALS
    )

    const candle = store.get(`${MARKET}-ONE_HOUR-0`)
    assert.ok(candle)
    assert.strictEqual(candle!.openRaw, P_10, 'open is the pre-trade price')
    assert.strictEqual(candle!.closeRaw, P_8, 'close is the post-trade price')
    assert.strictEqual(candle!.highRaw, P_10, 'high is max(pre, post)')
    assert.strictEqual(candle!.lowRaw, P_8, 'low is min(pre, post)')
  })

  it('falls back to post-trade price when preTradePriceRaw is 0 (cold start)', async () => {
    const { store, context } = makeContext()
    await updatePriceCandles(
      context as never,
      MARKET,
      {
        newPriceRaw: P_10,
        newPriceFormatted: '10',
        preTradePriceRaw: 0n,
        preTradePriceFormatted: '0',
        reserveAmountRaw: 1_000_000n,
        reserveAmountFormatted: '1',
        timestamp: T_FIRST,
      },
      'ONE_HOUR',
      RESERVE_DECIMALS
    )

    const candle = store.get(`${MARKET}-ONE_HOUR-0`)
    assert.ok(candle)
    assert.strictEqual(candle!.openRaw, P_10, 'open falls back to post-trade')
    assert.strictEqual(candle!.openFormatted, '10')
  })

  it('adjacent buckets are continuous (prev close = next open) when fed from the cache', async () => {
    const { store, context } = makeContext()

    // Bucket 0: pre=10, post=12 → close = 12.
    await updatePriceCandles(
      context as never,
      MARKET,
      {
        newPriceRaw: P_12,
        newPriceFormatted: '12',
        preTradePriceRaw: P_10,
        preTradePriceFormatted: '10',
        reserveAmountRaw: 1_000_000n,
        reserveAmountFormatted: '1',
        timestamp: T_FIRST,
      },
      'ONE_HOUR',
      RESERVE_DECIMALS
    )

    // Bucket 3600: pre=12 (matches prev close), post=15.
    await updatePriceCandles(
      context as never,
      MARKET,
      {
        newPriceRaw: P_15,
        newPriceFormatted: '15',
        preTradePriceRaw: P_12,
        preTradePriceFormatted: '12',
        reserveAmountRaw: 2_000_000n,
        reserveAmountFormatted: '2',
        timestamp: T_SECOND_BUCKET,
      },
      'ONE_HOUR',
      RESERVE_DECIMALS
    )

    const a = store.get(`${MARKET}-ONE_HOUR-0`)!
    const b = store.get(`${MARKET}-ONE_HOUR-3600`)!
    assert.strictEqual(a.closeRaw, b.openRaw, 'next-bucket open equals prev-bucket close')
  })

  it('updating an existing candle keeps open unchanged and rolls close', async () => {
    const { store, context } = makeContext()

    // First trade in bucket 0.
    await updatePriceCandles(
      context as never,
      MARKET,
      {
        newPriceRaw: P_12,
        newPriceFormatted: '12',
        preTradePriceRaw: P_10,
        preTradePriceFormatted: '10',
        reserveAmountRaw: 1_000_000n,
        reserveAmountFormatted: '1',
        timestamp: T_FIRST,
      },
      'ONE_HOUR',
      RESERVE_DECIMALS
    )

    // Second trade in same bucket: pre=12, post=15.
    await updatePriceCandles(
      context as never,
      MARKET,
      {
        newPriceRaw: P_15,
        newPriceFormatted: '15',
        preTradePriceRaw: P_12,
        preTradePriceFormatted: '12',
        reserveAmountRaw: 1_000_000n,
        reserveAmountFormatted: '1',
        timestamp: T_FIRST + 10n,
      },
      'ONE_HOUR',
      RESERVE_DECIMALS
    )

    const candle = store.get(`${MARKET}-ONE_HOUR-0`)!
    assert.strictEqual(candle.openRaw, P_10, 'open is sticky across trades in the same bucket')
    assert.strictEqual(candle.closeRaw, P_15, 'close advances to latest post-trade price')
    assert.strictEqual(candle.highRaw, P_15)
    assert.strictEqual(candle.lowRaw, P_10)
    assert.strictEqual(candle.trades, 2n)
  })
})
