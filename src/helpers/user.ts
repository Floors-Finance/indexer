import type { handlerContext } from 'generated'
import type {
  Account_t,
  UserMarketPosition_t,
  UserMarketPositionSnapshot_t,
} from 'generated/src/db/Entities.gen'

import { formatAmount, normalizeAddress } from './misc'
import { getSnapshotBucket } from './time'

/**
 * Get or create Account entity
 */
export async function getOrCreateAccount(
  context: handlerContext,
  address: string
): Promise<Account_t> {
  const normalizedAddress = normalizeAddress(address)
  let account = await context.Account.get(normalizedAddress)

  if (!account) {
    account = { id: normalizedAddress }
    context.Account.set(account)
  }

  return account
}

/**
 * Get or create UserMarketPosition
 */
export async function getOrCreateUserMarketPosition(
  context: handlerContext,
  userId: string,
  marketId: string,
  tokenDecimals: number = 18,
  blockTimestamp?: bigint
): Promise<UserMarketPosition_t> {
  const normalizedUserId = normalizeAddress(userId)
  const normalizedMarketId = normalizeAddress(marketId)
  const positionId = `${normalizedUserId}-${normalizedMarketId}`
  let position = await context.UserMarketPosition.get(positionId)

  if (!position) {
    const zeroAmount = formatAmount(0n, tokenDecimals)
    position = {
      id: positionId,
      user_id: normalizedUserId,
      market_id: normalizedMarketId,
      netFTokenChangeRaw: zeroAmount.raw,
      netFTokenChangeFormatted: zeroAmount.formatted,
      totalDebtRaw: zeroAmount.raw,
      totalDebtFormatted: zeroAmount.formatted,
      lockedCollateralRaw: zeroAmount.raw,
      lockedCollateralFormatted: zeroAmount.formatted,
      stakedAmountRaw: zeroAmount.raw,
      stakedAmountFormatted: zeroAmount.formatted,
      claimableRewardsRaw: zeroAmount.raw,
      claimableRewardsFormatted: zeroAmount.formatted,
      presaleDepositRaw: zeroAmount.raw,
      presaleDepositFormatted: zeroAmount.formatted,
      presaleLeverage: 0n,
      lastUpdatedAt: blockTimestamp ?? BigInt(Math.floor(Date.now() / 1000)),
    }
    context.UserMarketPosition.set(position)
  }

  return position
}

export type UserMarketPositionDeltaInput = {
  netFTokenChangeDelta?: bigint
  totalDebtDelta?: bigint
  lockedCollateralDelta?: bigint
  stakedAmountDelta?: bigint
  claimableRewardsDelta?: bigint
  presaleDepositDelta?: bigint
  presaleLeverage?: bigint
  issuanceTokenDecimals: number
  reserveTokenDecimals: number
  timestamp: bigint
}

/**
 * Build an updated UserMarketPosition with normalized formatting for derived counters.
 * The caller is responsible for persisting the returned entity.
 */
export function buildUpdatedUserMarketPosition(
  position: UserMarketPosition_t,
  updates: UserMarketPositionDeltaInput
): UserMarketPosition_t {
  let netFTokenChangeRaw = position.netFTokenChangeRaw
  let netFTokenChangeFormatted = position.netFTokenChangeFormatted
  if (updates.netFTokenChangeDelta && updates.netFTokenChangeDelta !== 0n) {
    netFTokenChangeRaw = position.netFTokenChangeRaw + updates.netFTokenChangeDelta
    netFTokenChangeFormatted = formatAmount(
      netFTokenChangeRaw,
      updates.issuanceTokenDecimals
    ).formatted
  }

  let totalDebtRaw = position.totalDebtRaw
  let totalDebtFormatted = position.totalDebtFormatted
  if (updates.totalDebtDelta && updates.totalDebtDelta !== 0n) {
    totalDebtRaw = position.totalDebtRaw + updates.totalDebtDelta
    totalDebtFormatted = formatAmount(totalDebtRaw, updates.reserveTokenDecimals).formatted
  }

  let lockedCollateralRaw = position.lockedCollateralRaw
  let lockedCollateralFormatted = position.lockedCollateralFormatted
  if (updates.lockedCollateralDelta && updates.lockedCollateralDelta !== 0n) {
    lockedCollateralRaw = position.lockedCollateralRaw + updates.lockedCollateralDelta
    lockedCollateralFormatted = formatAmount(
      lockedCollateralRaw,
      updates.issuanceTokenDecimals
    ).formatted
  }

  let stakedAmountRaw = position.stakedAmountRaw
  let stakedAmountFormatted = position.stakedAmountFormatted
  if (updates.stakedAmountDelta && updates.stakedAmountDelta !== 0n) {
    stakedAmountRaw = position.stakedAmountRaw + updates.stakedAmountDelta
    stakedAmountFormatted = formatAmount(stakedAmountRaw, updates.issuanceTokenDecimals).formatted
  }

  let claimableRewardsRaw = position.claimableRewardsRaw
  let claimableRewardsFormatted = position.claimableRewardsFormatted
  if (updates.claimableRewardsDelta && updates.claimableRewardsDelta !== 0n) {
    claimableRewardsRaw = position.claimableRewardsRaw + updates.claimableRewardsDelta
    claimableRewardsFormatted = formatAmount(
      claimableRewardsRaw,
      updates.reserveTokenDecimals
    ).formatted
  }

  let presaleDepositRaw = position.presaleDepositRaw
  let presaleDepositFormatted = position.presaleDepositFormatted
  if (updates.presaleDepositDelta && updates.presaleDepositDelta !== 0n) {
    presaleDepositRaw = position.presaleDepositRaw + updates.presaleDepositDelta
    presaleDepositFormatted = formatAmount(
      presaleDepositRaw,
      updates.reserveTokenDecimals
    ).formatted
  }

  const presaleLeverage =
    typeof updates.presaleLeverage === 'bigint' ? updates.presaleLeverage : position.presaleLeverage

  return {
    ...position,
    netFTokenChangeRaw,
    netFTokenChangeFormatted,
    totalDebtRaw,
    totalDebtFormatted,
    lockedCollateralRaw,
    lockedCollateralFormatted,
    stakedAmountRaw,
    stakedAmountFormatted,
    claimableRewardsRaw,
    claimableRewardsFormatted,
    presaleDepositRaw,
    presaleDepositFormatted,
    presaleLeverage,
    lastUpdatedAt: updates.timestamp,
  }
}

/**
 * Persist a UserMarketPosition AND append a time-bucketed holdings snapshot.
 *
 * Use this in place of a bare `context.UserMarketPosition.set(...)` everywhere
 * a position is mutated (trade / credit / staking / presale handlers). The
 * snapshot is what gives the portfolio chart a real history: holdings only
 * change on the user's own events, so this is event-sparse and O(1) per write.
 *
 * The snapshot is keyed by `${user}-${market}-${bucket}` and upserted, so many
 * events in one hour collapse to a single row and replays stay idempotent
 * (every stored field is absolute cumulative state, not a delta).
 *
 * Portfolio *value* is intentionally not stored here — it is reconstructed at
 * query time by joining these holdings against MarketSnapshot price history.
 */
export function commitUserMarketPosition(
  context: handlerContext,
  position: UserMarketPosition_t
): void {
  context.UserMarketPosition.set(position)

  const bucket = getSnapshotBucket(position.lastUpdatedAt)
  const snapshot: UserMarketPositionSnapshot_t = {
    id: `${position.user_id}-${position.market_id}-${bucket}`,
    user_id: position.user_id,
    market_id: position.market_id,
    timestamp: bucket,
    netFTokenChangeRaw: position.netFTokenChangeRaw,
    netFTokenChangeFormatted: position.netFTokenChangeFormatted,
    stakedAmountRaw: position.stakedAmountRaw,
    stakedAmountFormatted: position.stakedAmountFormatted,
    lockedCollateralRaw: position.lockedCollateralRaw,
    lockedCollateralFormatted: position.lockedCollateralFormatted,
    totalDebtRaw: position.totalDebtRaw,
    totalDebtFormatted: position.totalDebtFormatted,
    presaleDepositRaw: position.presaleDepositRaw,
    presaleDepositFormatted: position.presaleDepositFormatted,
  }
  context.UserMarketPositionSnapshot.set(snapshot)
}
