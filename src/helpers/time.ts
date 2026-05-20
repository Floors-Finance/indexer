import type { handlerContext } from 'generated'
import type { GlobalStatsSnapshot_t, MarketSnapshot_t } from 'generated/src/db/Entities.gen'
import type { CandlePeriod_t, SnapshotPeriod_t } from 'generated/src/db/Enums.gen'

import { formatAmount, normalizeAmount } from './misc'

const GLOBAL_STATS_ID = 'global'

/**
 * Bucket size for point-in-time snapshots (MarketSnapshot, UserMarketPositionSnapshot).
 * Hourly — all snapshot entities floor their timestamp to this so they share a
 * common time axis and can be joined cleanly when charting.
 */
export const SNAPSHOT_BUCKET_SECONDS = 3600n

/**
 * Floor a block timestamp to its snapshot bucket.
 * Returns 0n for timestamps inside the first bucket (mirrors legacy behaviour).
 */
export function getSnapshotBucket(timestamp: bigint): bigint {
  if (timestamp < SNAPSHOT_BUCKET_SECONDS) {
    return 0n
  }
  return (timestamp / SNAPSHOT_BUCKET_SECONDS) * SNAPSHOT_BUCKET_SECONDS
}

/**
 * Snapshot period configurations for GlobalStatsSnapshot
 */
const SNAPSHOT_PERIOD_SECONDS: Record<SnapshotPeriod_t, bigint> = {
  ONE_HOUR: 3600n,
  FOUR_HOURS: 14400n,
  ONE_DAY: 86400n,
}

/**
 * Update the GlobalStats entity with the latest block timestamp.
 * This ensures the frontend can always get the current chain time,
 * even when time warps are used (e.g., anvil_setTime).
 */
export async function updateLatestBlockTimestamp(
  context: handlerContext,
  timestamp: bigint
): Promise<void> {
  const globalStats = await context.GlobalStats.get(GLOBAL_STATS_ID)

  if (globalStats) {
    // Only update if this timestamp is newer
    if (timestamp > globalStats.lastUpdatedAt) {
      context.GlobalStats.set({
        ...globalStats,
        lastUpdatedAt: timestamp,
      })
    }
  } else {
    // Create initial GlobalStats entity
    context.GlobalStats.set({
      id: GLOBAL_STATS_ID,
      totalMarkets: 0n,
      activeMarkets: 0n,
      totalVolumeRaw: 0n,
      totalVolumeFormatted: '0',
      totalOutstandingDebtRaw: 0n,
      totalOutstandingDebtFormatted: '0',
      totalLockedCollateralRaw: 0n,
      totalLockedCollateralFormatted: '0',
      lastUpdatedAt: timestamp,
    })
  }
}

/**
 * Update GlobalStatsSnapshots for all periods (1h, 4h, 1d)
 * Creates time-bucketed snapshots of TVL, Market Cap, and volume
 * Also updates the GlobalStats entity with the latest block timestamp
 */
export async function updateGlobalStatsSnapshots(
  context: handlerContext,
  timestamp: bigint,
  metrics: {
    totalValueLockedRaw: bigint
    totalMarketCapRaw: bigint
    periodVolumeRaw: bigint
    totalMarkets: bigint
    activeMarkets: bigint
  }
): Promise<void> {
  const periods: SnapshotPeriod_t[] = ['ONE_HOUR', 'FOUR_HOURS', 'ONE_DAY']

  // Update GlobalStats with latest block timestamp
  // This ensures frontend can get current chain time even after time warps
  await updateLatestBlockTimestamp(context, timestamp)

  for (const period of periods) {
    const periodSeconds = SNAPSHOT_PERIOD_SECONDS[period]
    const snapshotTimestamp = (timestamp / periodSeconds) * periodSeconds
    const snapshotId = `global-${period}-${snapshotTimestamp}`

    const existing = await context.GlobalStatsSnapshot.get(snapshotId)

    if (existing) {
      // Replace with latest point-in-time values — periodVolumeRaw is the rolling
      // 24h total from the in-memory cache, so it is idempotent on indexer restart/replay.
      // (Accumulating would double-count replayed events into already-persisted snapshots.)
      const volumeFormatted = formatAmount(metrics.periodVolumeRaw, 18)
      const tvlFormatted = formatAmount(metrics.totalValueLockedRaw, 18)
      const mcFormatted = formatAmount(metrics.totalMarketCapRaw, 18)

      context.GlobalStatsSnapshot.set({
        ...existing,
        totalValueLockedRaw: metrics.totalValueLockedRaw,
        totalValueLockedFormatted: tvlFormatted.formatted,
        totalMarketCapRaw: metrics.totalMarketCapRaw,
        totalMarketCapFormatted: mcFormatted.formatted,
        periodVolumeRaw: metrics.periodVolumeRaw,
        periodVolumeFormatted: volumeFormatted.formatted,
        totalMarkets: metrics.totalMarkets,
        activeMarkets: metrics.activeMarkets,
      })
    } else {
      // Create new snapshot
      const tvlFormatted = formatAmount(metrics.totalValueLockedRaw, 18)
      const mcFormatted = formatAmount(metrics.totalMarketCapRaw, 18)
      const volumeFormatted = formatAmount(metrics.periodVolumeRaw, 18)

      const snapshot: GlobalStatsSnapshot_t = {
        id: snapshotId,
        period,
        timestamp: snapshotTimestamp,
        totalValueLockedRaw: metrics.totalValueLockedRaw,
        totalValueLockedFormatted: tvlFormatted.formatted,
        totalMarketCapRaw: metrics.totalMarketCapRaw,
        totalMarketCapFormatted: mcFormatted.formatted,
        periodVolumeRaw: metrics.periodVolumeRaw,
        periodVolumeFormatted: volumeFormatted.formatted,
        totalMarkets: metrics.totalMarkets,
        activeMarkets: metrics.activeMarkets,
      }

      context.GlobalStatsSnapshot.set(snapshot)
    }
  }
}

/**
 * Update PriceCandle for charting data
 * Aggregates trades into OHLCV candles.
 *
 * `preTradePriceRaw` is the market price *before* this trade applied — i.e.
 * the previous candle's close. Using it as `open` makes adjacent candles
 * continuous on the chart (no synthetic vertical jump at bucket boundaries).
 * Pass 0n only when no previous price is known (very first trade ever on a
 * market that initialised with `currentPriceRaw=0`); in that case we fall
 * back to the post-trade price to preserve old behaviour.
 */
export async function updatePriceCandles(
  context: handlerContext,
  marketId: string,
  trade: {
    newPriceRaw: bigint
    newPriceFormatted: string
    preTradePriceRaw: bigint
    preTradePriceFormatted: string
    reserveAmountRaw: bigint
    reserveAmountFormatted: string
    timestamp: bigint
  },
  period: CandlePeriod_t,
  tokenDecimals: number = 18
): Promise<void> {
  // Calculate candle timestamp based on period
  const periodSeconds: Record<string, number> = {
    ONE_HOUR: 3600,
    FOUR_HOURS: 14400,
    ONE_DAY: 86400,
  }

  const periodSec = periodSeconds[period]
  const candleTimestamp = BigInt(Math.floor(Number(trade.timestamp) / periodSec) * periodSec)

  const candleId = `${marketId}-${period}-${candleTimestamp}`
  let candle = await context.PriceCandle.get(candleId)

  if (!candle) {
    // Pre-trade price is the previous candle's close. Falling back to the
    // post-trade price covers the cold-start case where no prior price exists.
    const hasPreTradePrice = trade.preTradePriceRaw > 0n
    const openRaw = hasPreTradePrice ? trade.preTradePriceRaw : trade.newPriceRaw
    const openFormatted = hasPreTradePrice
      ? trade.preTradePriceFormatted
      : trade.newPriceFormatted

    // Both pre- and post-trade prices belong to this bucket's range.
    const highRaw = openRaw > trade.newPriceRaw ? openRaw : trade.newPriceRaw
    const lowRaw = openRaw < trade.newPriceRaw ? openRaw : trade.newPriceRaw
    const highFormatted =
      highRaw === openRaw ? openFormatted : trade.newPriceFormatted
    const lowFormatted = lowRaw === openRaw ? openFormatted : trade.newPriceFormatted

    candle = {
      id: candleId,
      market_id: marketId,
      period,
      timestamp: candleTimestamp,
      openRaw,
      openFormatted,
      highRaw,
      highFormatted,
      lowRaw,
      lowFormatted,
      closeRaw: trade.newPriceRaw,
      closeFormatted: trade.newPriceFormatted,
      volumeRaw: trade.reserveAmountRaw,
      volumeFormatted: trade.reserveAmountFormatted,
      trades: 1n,
    }
  } else {
    // Update existing candle. Pre-trade price for this trade equals the
    // existing candle.closeRaw, which is already inside the [low, high] range,
    // so it doesn't need to be folded in again.
    const newHigh = trade.newPriceRaw > candle.highRaw
    const newLow = trade.newPriceRaw < candle.lowRaw
    const newVolume = formatAmount(candle.volumeRaw + trade.reserveAmountRaw, tokenDecimals)

    candle = {
      ...candle,
      highRaw: newHigh ? trade.newPriceRaw : candle.highRaw,
      highFormatted: newHigh ? trade.newPriceFormatted : candle.highFormatted,
      lowRaw: newLow ? trade.newPriceRaw : candle.lowRaw,
      lowFormatted: newLow ? trade.newPriceFormatted : candle.lowFormatted,
      closeRaw: trade.newPriceRaw,
      closeFormatted: trade.newPriceFormatted,
      volumeRaw: newVolume.raw,
      volumeFormatted: newVolume.formatted,
      trades: candle.trades + 1n,
    }
  }

  context.PriceCandle.set(candle)
}

/**
 * Create MarketSnapshot for historical data
 * Note: Market entity contains both static and dynamic state fields
 */
export async function createMarketSnapshot(
  context: handlerContext,
  marketId: string,
  market: {
    currentPriceRaw: bigint
    currentPriceFormatted: string
    floorPriceRaw: bigint
    floorPriceFormatted: string
    totalSupplyRaw: bigint
    totalSupplyFormatted: string
    marketSupplyRaw: bigint
    marketSupplyFormatted: string
  },
  volume24h: bigint,
  trades24h: bigint,
  timestamp: bigint,
  tokenDecimals: number = 18
): Promise<void> {
  const snapshotId = `${marketId}-${timestamp}`
  const volume = formatAmount(volume24h, tokenDecimals)
  const snapshot: MarketSnapshot_t = {
    id: snapshotId,
    market_id: marketId,
    timestamp,
    priceRaw: market.currentPriceRaw,
    priceFormatted: market.currentPriceFormatted,
    floorPriceRaw: market.floorPriceRaw,
    floorPriceFormatted: market.floorPriceFormatted,
    totalSupplyRaw: market.totalSupplyRaw,
    totalSupplyFormatted: market.totalSupplyFormatted,
    marketSupplyRaw: market.marketSupplyRaw,
    marketSupplyFormatted: market.marketSupplyFormatted,
    volume24hRaw: volume.raw,
    volume24hFormatted: volume.formatted,
    trades24h,
  }

  context.MarketSnapshot.set(snapshot)
}

/**
 * Apply debt and collateral deltas to the GlobalStats entity.
 * Called from credit handlers when loans are created, repaid, rebalanced, or closed.
 * Values are normalized to 18 decimals before accumulation.
 */
export async function applyGlobalDebtDelta(
  context: handlerContext,
  params: {
    debtDeltaRaw: bigint
    collateralDeltaRaw: bigint
    debtTokenDecimals: number
    collateralTokenDecimals: number
    timestamp: bigint
  }
): Promise<void> {
  const existing = await context.GlobalStats.get(GLOBAL_STATS_ID)
  const globalStats = existing ?? {
    id: GLOBAL_STATS_ID,
    totalMarkets: 0n,
    activeMarkets: 0n,
    totalVolumeRaw: 0n,
    totalVolumeFormatted: '0',
    totalOutstandingDebtRaw: 0n,
    totalOutstandingDebtFormatted: '0',
    totalLockedCollateralRaw: 0n,
    totalLockedCollateralFormatted: '0',
    lastUpdatedAt: params.timestamp,
  }

  const normalizedDebt = normalizeAmount(params.debtDeltaRaw, params.debtTokenDecimals, 18)
  const normalizedCollateral = normalizeAmount(
    params.collateralDeltaRaw,
    params.collateralTokenDecimals,
    18
  )

  const newDebtRaw = globalStats.totalOutstandingDebtRaw + normalizedDebt
  const newCollateralRaw = globalStats.totalLockedCollateralRaw + normalizedCollateral

  // Clamp to 0 — rounding or re-processing can push values slightly negative
  const clampedDebt = newDebtRaw < 0n ? 0n : newDebtRaw
  const clampedCollateral = newCollateralRaw < 0n ? 0n : newCollateralRaw

  context.GlobalStats.set({
    ...globalStats,
    totalOutstandingDebtRaw: clampedDebt,
    totalOutstandingDebtFormatted: formatAmount(clampedDebt, 18).formatted,
    totalLockedCollateralRaw: clampedCollateral,
    totalLockedCollateralFormatted: formatAmount(clampedCollateral, 18).formatted,
    lastUpdatedAt: params.timestamp,
  })
}

export { GLOBAL_STATS_ID }
