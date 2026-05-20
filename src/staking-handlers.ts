// Staking event handlers for Floor Markets DeFi Platform

import type { handlerContext } from 'generated'
import { decodeAbiParameters, parseAbiParameters } from 'viem'

import type {
  StakePosition_t,
  StakingManager_t,
  Strategy_t,
  Token_t,
} from '../generated/src/db/Entities.gen'
import type { StakePositionStatus_t, StakingActivityType_t } from '../generated/src/db/Enums.gen'
import { StakingManager } from '../generated/src/Handlers.gen'
import {
  buildUpdatedUserMarketPosition,
  commitUserMarketPosition,
  formatAmount,
  getOrCreateAccount,
  getOrCreateModuleRegistry,
  getOrCreateUserMarketPosition,
  getStrategyMetadata,
  handlerErrorWrapper,
  normalizeAddress,
} from './helpers'

const STAKING_CONFIG_PARAMS = parseAbiParameters('uint256')

// ============================================================
// ModuleInitialized - Create/update StakingManager
// ============================================================

StakingManager.ModuleInitialized.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const stakingManagerId = normalizeAddress(event.srcAddress)
    const floorAddress = normalizeAddress(event.params.floor)
    const timestamp = BigInt(event.block.timestamp)

    context.log.info(
      `[StakingManager.ModuleInitialized] Handler invoked | stakingManagerId=${stakingManagerId} | floor=${floorAddress}`
    )

    const existingManager = await context.StakingManager.get(stakingManagerId)
    const performanceFeeBps =
      existingManager?.performanceFeeBps ??
      decodeStakingPerformanceFee(event.params.configData as `0x${string}`, context.log)

    const stakingManager: StakingManager_t = {
      id: stakingManagerId,
      market_id: floorAddress,
      performanceFeeBps,
      totalStakedIssuanceRaw: existingManager?.totalStakedIssuanceRaw ?? 0n,
      totalStakedIssuanceFormatted: existingManager?.totalStakedIssuanceFormatted ?? '0',
      totalCollateralDeployedRaw: existingManager?.totalCollateralDeployedRaw ?? 0n,
      totalCollateralDeployedFormatted: existingManager?.totalCollateralDeployedFormatted ?? '0',
      totalYieldHarvestedRaw: existingManager?.totalYieldHarvestedRaw ?? 0n,
      totalYieldHarvestedFormatted: existingManager?.totalYieldHarvestedFormatted ?? '0',
      totalFeesCapturedRaw: existingManager?.totalFeesCapturedRaw ?? 0n,
      totalFeesCapturedFormatted: existingManager?.totalFeesCapturedFormatted ?? '0',
      createdAt: existingManager?.createdAt ?? timestamp,
      lastUpdatedAt: timestamp,
    }

    context.StakingManager.set(stakingManager)

    // Create or update ModuleRegistry with staking address
    await getOrCreateModuleRegistry(context, floorAddress, 'staking', stakingManagerId, timestamp)

    context.log.info(
      `[StakingManager.ModuleInitialized] ✅ StakingManager created | id=${stakingManagerId} | market=${floorAddress}`
    )
  })
)

// ============================================================
// StrategyAdded - Create Strategy entity
// ============================================================

StakingManager.StrategyAdded.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const stakingManagerId = normalizeAddress(event.srcAddress)
    const strategyAddress = normalizeAddress(event.params.strategy_)
    const timestamp = BigInt(event.block.timestamp)

    context.log.info(
      `[StakingManager.StrategyAdded] Handler invoked | stakingManagerId=${stakingManagerId} | strategy=${strategyAddress}`
    )

    // Fetch strategy metadata (name, symbol) via RPC
    const metadata = await getStrategyMetadata(context, event.chainId, strategyAddress)

    // Resolve collateral token from StakingManager → Market → reserveToken
    let collateralToken_id: string | undefined

    const manager = await context.StakingManager.get(stakingManagerId)
    if (manager) {
      const market = await context.Market.get(manager.market_id)
      if (market) {
        collateralToken_id = market.reserveToken_id
      }
    }

    const strategy: Strategy_t = {
      id: strategyAddress,
      stakingManager_id: stakingManagerId,
      isActive: true,
      name: metadata?.name,
      symbol: metadata?.symbol,
      collateralToken_id,
      addedAt: timestamp,
      removedAt: undefined,
      transactionHash: event.transaction.hash,
    }

    context.Strategy.set(strategy)

    // Strategies are per-market (collateral exclusive to their owning floor), so
    // they are not tracked in the global registry — each market discovers its
    // own strategy via its StakingManager.
    context.log.info(
      `[StakingManager.StrategyAdded] ✅ Strategy added | id=${strategyAddress} | stakingManager=${stakingManagerId}`
    )
  })
)

// ============================================================
// StrategyRemoved - Update Strategy entity
// ============================================================

StakingManager.StrategyRemoved.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const stakingManagerId = normalizeAddress(event.srcAddress)
    const strategyAddress = normalizeAddress(event.params.strategy_)
    const timestamp = BigInt(event.block.timestamp)

    context.log.info(
      `[StakingManager.StrategyRemoved] Handler invoked | stakingManagerId=${stakingManagerId} | strategy=${strategyAddress}`
    )

    const strategy = await context.Strategy.get(strategyAddress)

    if (!strategy) {
      context.log.warn(
        `[StakingManager.StrategyRemoved] Strategy not found | id=${strategyAddress}`
      )
      return
    }

    const updatedStrategy: Strategy_t = {
      ...strategy,
      isActive: false,
      removedAt: timestamp,
    }

    context.Strategy.set(updatedStrategy)

    context.log.info(
      `[StakingManager.StrategyRemoved] ✅ Strategy removed | id=${strategyAddress} | stakingManager=${stakingManagerId}`
    )
  })
)

// ============================================================
// PerformanceFeeUpdated - Update StakingManager fee
// ============================================================

StakingManager.PerformanceFeeUpdated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const stakingManagerId = normalizeAddress(event.srcAddress)
    const timestamp = BigInt(event.block.timestamp)

    context.log.info(
      `[StakingManager.PerformanceFeeUpdated] Handler invoked | stakingManagerId=${stakingManagerId} | newFee=${event.params.newFeeBps_}`
    )

    const manager = await context.StakingManager.get(stakingManagerId)

    if (!manager) {
      context.log.warn(
        `[StakingManager.PerformanceFeeUpdated] StakingManager not found | id=${stakingManagerId}`
      )
      return
    }

    const updatedManager: StakingManager_t = {
      ...manager,
      performanceFeeBps: event.params.newFeeBps_,
      lastUpdatedAt: timestamp,
    }

    context.StakingManager.set(updatedManager)

    context.log.info(
      `[StakingManager.PerformanceFeeUpdated] ✅ Fee updated | stakingManagerId=${stakingManagerId} | oldFee=${event.params.oldFeeBps_} | newFee=${event.params.newFeeBps_}`
    )
  })
)

// ============================================================
// Staked - Create/update StakePosition and StakingActivity
// ============================================================

StakingManager.Staked.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const stakingManagerId = normalizeAddress(event.srcAddress)
    const userAddress = normalizeAddress(event.params.user_)
    const strategyAddress = normalizeAddress(event.params.strategy_)
    const timestamp = BigInt(event.block.timestamp)

    context.log.info(
      `[StakingManager.Staked] Handler invoked | stakingManagerId=${stakingManagerId} | user=${userAddress} | strategy=${strategyAddress}`
    )

    const stakingContext = await loadStakingContext(context, stakingManagerId)
    if (!stakingContext) {
      context.log.warn(
        `[StakingManager.Staked] StakingManager context not found | id=${stakingManagerId}`
      )
      return
    }

    const { manager, issuanceToken, reserveToken } = stakingContext
    const user = await getOrCreateAccount(context, event.params.user_)

    // Create or update position
    const positionId = `${userAddress}-${stakingManagerId}-${strategyAddress}`
    const existingPosition = await context.StakePosition.get(positionId)

    const issuanceAmount = formatAmount(event.params.issuanceTokenAmount_, issuanceToken.decimals)
    const collateralAmount = formatAmount(event.params.collateralDeployed_, reserveToken.decimals)
    const floorPrice = formatAmount(event.params.floorPrice_, reserveToken.decimals)

    const position: StakePosition_t = {
      id: positionId,
      user_id: user.id,
      stakingManager_id: stakingManagerId,
      strategy_id: strategyAddress,
      issuanceTokenAmountRaw: existingPosition
        ? existingPosition.issuanceTokenAmountRaw + event.params.issuanceTokenAmount_
        : event.params.issuanceTokenAmount_,
      issuanceTokenAmountFormatted: existingPosition
        ? formatAmount(
            existingPosition.issuanceTokenAmountRaw + event.params.issuanceTokenAmount_,
            issuanceToken.decimals
          ).formatted
        : issuanceAmount.formatted,
      collateralDeployedRaw: existingPosition
        ? existingPosition.collateralDeployedRaw + event.params.collateralDeployed_
        : event.params.collateralDeployed_,
      collateralDeployedFormatted: existingPosition
        ? formatAmount(
            existingPosition.collateralDeployedRaw + event.params.collateralDeployed_,
            reserveToken.decimals
          ).formatted
        : collateralAmount.formatted,
      floorPriceAtStakeRaw: event.params.floorPrice_,
      floorPriceAtStakeFormatted: floorPrice.formatted,
      totalYieldHarvestedRaw: existingPosition?.totalYieldHarvestedRaw ?? 0n,
      totalYieldHarvestedFormatted: existingPosition?.totalYieldHarvestedFormatted ?? '0',
      totalFeePaidRaw: existingPosition?.totalFeePaidRaw ?? 0n,
      totalFeePaidFormatted: existingPosition?.totalFeePaidFormatted ?? '0',
      status: 'ACTIVE' as StakePositionStatus_t,
      createdAt: existingPosition?.createdAt ?? timestamp,
      lastUpdatedAt: timestamp,
      transactionHash: event.transaction.hash,
    }

    context.StakePosition.set(position)

    // Create activity record
    const activityId = `${event.transaction.hash}-${event.logIndex}`
    const activity = {
      id: activityId,
      position_id: positionId,
      stakingManager_id: stakingManagerId,
      user_id: user.id,
      activityType: 'STAKE' as StakingActivityType_t,
      issuanceTokenAmountRaw: event.params.issuanceTokenAmount_,
      issuanceTokenAmountFormatted: issuanceAmount.formatted,
      collateralAmountRaw: event.params.collateralDeployed_,
      collateralAmountFormatted: collateralAmount.formatted,
      yieldAmountRaw: undefined,
      yieldAmountFormatted: undefined,
      feeAmountRaw: undefined,
      feeAmountFormatted: undefined,
      receiver: undefined,
      timestamp,
      transactionHash: event.transaction.hash,
    }

    context.StakingActivity.set(activity)

    // Update StakingManager totals
    const updatedManager: StakingManager_t = {
      ...manager,
      totalStakedIssuanceRaw: manager.totalStakedIssuanceRaw + event.params.issuanceTokenAmount_,
      totalStakedIssuanceFormatted: formatAmount(
        manager.totalStakedIssuanceRaw + event.params.issuanceTokenAmount_,
        issuanceToken.decimals
      ).formatted,
      totalCollateralDeployedRaw:
        manager.totalCollateralDeployedRaw + event.params.collateralDeployed_,
      totalCollateralDeployedFormatted: formatAmount(
        manager.totalCollateralDeployedRaw + event.params.collateralDeployed_,
        reserveToken.decimals
      ).formatted,
      lastUpdatedAt: timestamp,
    }

    context.StakingManager.set(updatedManager)

    // Update UserMarketPosition (optional - tracks staked amount for user)
    const userPosition = await getOrCreateUserMarketPosition(
      context,
      user.id,
      manager.market_id,
      issuanceToken.decimals,
      timestamp
    )
    const updatedUserPosition = {
      ...userPosition,
      stakedAmountRaw: userPosition.stakedAmountRaw + event.params.issuanceTokenAmount_,
      stakedAmountFormatted: formatAmount(
        userPosition.stakedAmountRaw + event.params.issuanceTokenAmount_,
        issuanceToken.decimals
      ).formatted,
      lastUpdatedAt: timestamp,
    }
    commitUserMarketPosition(context, updatedUserPosition)

    context.log.info(
      `[StakingManager.Staked] ✅ Position updated | positionId=${positionId} | issuance=${issuanceAmount.formatted} | collateral=${collateralAmount.formatted}`
    )
  })
)

// ============================================================
// YieldHarvested - Update position and create activity
// ============================================================

StakingManager.YieldHarvested.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const stakingManagerId = normalizeAddress(event.srcAddress)
    const userAddress = normalizeAddress(event.params.user_)
    const strategyAddress = normalizeAddress(event.params.strategy_)
    const timestamp = BigInt(event.block.timestamp)

    context.log.info(
      `[StakingManager.YieldHarvested] Handler invoked | stakingManagerId=${stakingManagerId} | user=${userAddress} | strategy=${strategyAddress}`
    )

    const stakingContext = await loadStakingContext(context, stakingManagerId)
    if (!stakingContext) {
      context.log.warn(
        `[StakingManager.YieldHarvested] StakingManager context not found | id=${stakingManagerId}`
      )
      return
    }

    const { manager, issuanceToken, reserveToken } = stakingContext
    const user = await getOrCreateAccount(context, event.params.user_)

    const positionId = `${userAddress}-${stakingManagerId}-${strategyAddress}`
    const position = await context.StakePosition.get(positionId)

    if (!position) {
      context.log.warn(
        `[StakingManager.YieldHarvested] Position not found | positionId=${positionId}`
      )
      return
    }

    const yieldAmount = formatAmount(event.params.netYield_, reserveToken.decimals)
    const feeAmount = formatAmount(event.params.fee_, reserveToken.decimals)

    // Update position totals
    const updatedPosition: StakePosition_t = {
      ...position,
      totalYieldHarvestedRaw: position.totalYieldHarvestedRaw + event.params.netYield_,
      totalYieldHarvestedFormatted: formatAmount(
        position.totalYieldHarvestedRaw + event.params.netYield_,
        reserveToken.decimals
      ).formatted,
      totalFeePaidRaw: position.totalFeePaidRaw + event.params.fee_,
      totalFeePaidFormatted: formatAmount(
        position.totalFeePaidRaw + event.params.fee_,
        reserveToken.decimals
      ).formatted,
      lastUpdatedAt: timestamp,
    }

    context.StakePosition.set(updatedPosition)

    // Create activity record
    const activityId = `${event.transaction.hash}-${event.logIndex}`
    const activity = {
      id: activityId,
      position_id: positionId,
      stakingManager_id: stakingManagerId,
      user_id: user.id,
      activityType: 'HARVEST' as StakingActivityType_t,
      issuanceTokenAmountRaw: undefined,
      issuanceTokenAmountFormatted: undefined,
      collateralAmountRaw: position.collateralDeployedRaw,
      collateralAmountFormatted: position.collateralDeployedFormatted,
      yieldAmountRaw: event.params.netYield_,
      yieldAmountFormatted: yieldAmount.formatted,
      feeAmountRaw: event.params.fee_,
      feeAmountFormatted: feeAmount.formatted,
      receiver: normalizeAddress(event.params.receiver_),
      timestamp,
      transactionHash: event.transaction.hash,
    }

    context.StakingActivity.set(activity)

    // Update StakingManager totals
    const updatedManager: StakingManager_t = {
      ...manager,
      totalYieldHarvestedRaw: manager.totalYieldHarvestedRaw + event.params.netYield_,
      totalYieldHarvestedFormatted: formatAmount(
        manager.totalYieldHarvestedRaw + event.params.netYield_,
        reserveToken.decimals
      ).formatted,
      totalFeesCapturedRaw: manager.totalFeesCapturedRaw + event.params.fee_,
      totalFeesCapturedFormatted: formatAmount(
        manager.totalFeesCapturedRaw + event.params.fee_,
        reserveToken.decimals
      ).formatted,
      lastUpdatedAt: timestamp,
    }

    context.StakingManager.set(updatedManager)

    // Update UserMarketPosition with cumulative harvested yield
    const userPosition = await getOrCreateUserMarketPosition(
      context,
      user.id,
      manager.market_id,
      issuanceToken.decimals,
      timestamp
    )
    const updatedUserPosition = buildUpdatedUserMarketPosition(userPosition, {
      claimableRewardsDelta: event.params.netYield_,
      issuanceTokenDecimals: issuanceToken.decimals,
      reserveTokenDecimals: reserveToken.decimals,
      timestamp,
    })
    commitUserMarketPosition(context, updatedUserPosition)

    context.log.info(
      `[StakingManager.YieldHarvested] ✅ Yield harvested | positionId=${positionId} | yield=${yieldAmount.formatted} | fee=${feeAmount.formatted}`
    )
  })
)

// ============================================================
// FundsWithdrawn - Update position status and create activity
// ============================================================

StakingManager.FundsWithdrawn.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const stakingManagerId = normalizeAddress(event.srcAddress)
    const userAddress = normalizeAddress(event.params.user_)
    const strategyAddress = normalizeAddress(event.params.strategy_)
    const timestamp = BigInt(event.block.timestamp)

    context.log.info(
      `[StakingManager.FundsWithdrawn] Handler invoked | stakingManagerId=${stakingManagerId} | user=${userAddress} | strategy=${strategyAddress}`
    )

    const stakingContext = await loadStakingContext(context, stakingManagerId)
    if (!stakingContext) {
      context.log.warn(
        `[StakingManager.FundsWithdrawn] StakingManager context not found | id=${stakingManagerId}`
      )
      return
    }

    const { manager, issuanceToken, reserveToken } = stakingContext
    const user = await getOrCreateAccount(context, event.params.user_)

    const positionId = `${userAddress}-${stakingManagerId}-${strategyAddress}`
    const position = await context.StakePosition.get(positionId)

    if (!position) {
      context.log.warn(
        `[StakingManager.FundsWithdrawn] Position not found | positionId=${positionId}`
      )
      return
    }

    const collateralWithdrawn = formatAmount(
      event.params.collateralWithdrawn_,
      reserveToken.decimals
    )
    const issuanceReturned = formatAmount(
      event.params.issuanceTokensReturned_,
      issuanceToken.decimals
    )

    // Update position - mark as withdrawn and subtract amounts
    const updatedPosition: StakePosition_t = {
      ...position,
      issuanceTokenAmountRaw:
        position.issuanceTokenAmountRaw - event.params.issuanceTokensReturned_,
      issuanceTokenAmountFormatted: formatAmount(
        position.issuanceTokenAmountRaw - event.params.issuanceTokensReturned_,
        issuanceToken.decimals
      ).formatted,
      collateralDeployedRaw: position.collateralDeployedRaw - event.params.collateralWithdrawn_,
      collateralDeployedFormatted: formatAmount(
        position.collateralDeployedRaw - event.params.collateralWithdrawn_,
        reserveToken.decimals
      ).formatted,
      status:
        position.issuanceTokenAmountRaw - event.params.issuanceTokensReturned_ === 0n
          ? ('WITHDRAWN' as StakePositionStatus_t)
          : position.status,
      lastUpdatedAt: timestamp,
    }

    context.StakePosition.set(updatedPosition)

    // Create activity record
    const activityId = `${event.transaction.hash}-${event.logIndex}`
    const activity = {
      id: activityId,
      position_id: positionId,
      stakingManager_id: stakingManagerId,
      user_id: user.id,
      activityType: 'WITHDRAW' as StakingActivityType_t,
      issuanceTokenAmountRaw: event.params.issuanceTokensReturned_,
      issuanceTokenAmountFormatted: issuanceReturned.formatted,
      collateralAmountRaw: event.params.collateralWithdrawn_,
      collateralAmountFormatted: collateralWithdrawn.formatted,
      yieldAmountRaw: undefined,
      yieldAmountFormatted: undefined,
      feeAmountRaw: undefined,
      feeAmountFormatted: undefined,
      receiver: normalizeAddress(event.params.receiver_),
      timestamp,
      transactionHash: event.transaction.hash,
    }

    context.StakingActivity.set(activity)

    // Update StakingManager totals
    const updatedManager: StakingManager_t = {
      ...manager,
      totalStakedIssuanceRaw: manager.totalStakedIssuanceRaw - event.params.issuanceTokensReturned_,
      totalStakedIssuanceFormatted: formatAmount(
        manager.totalStakedIssuanceRaw - event.params.issuanceTokensReturned_,
        issuanceToken.decimals
      ).formatted,
      totalCollateralDeployedRaw:
        manager.totalCollateralDeployedRaw - event.params.collateralWithdrawn_,
      totalCollateralDeployedFormatted: formatAmount(
        manager.totalCollateralDeployedRaw - event.params.collateralWithdrawn_,
        reserveToken.decimals
      ).formatted,
      lastUpdatedAt: timestamp,
    }

    context.StakingManager.set(updatedManager)

    // Update UserMarketPosition
    const userPosition = await getOrCreateUserMarketPosition(
      context,
      user.id,
      manager.market_id,
      issuanceToken.decimals,
      timestamp
    )
    const updatedUserPosition = {
      ...userPosition,
      stakedAmountRaw: userPosition.stakedAmountRaw - event.params.issuanceTokensReturned_,
      stakedAmountFormatted: formatAmount(
        userPosition.stakedAmountRaw - event.params.issuanceTokensReturned_,
        issuanceToken.decimals
      ).formatted,
      lastUpdatedAt: timestamp,
    }
    commitUserMarketPosition(context, updatedUserPosition)

    context.log.info(
      `[StakingManager.FundsWithdrawn] ✅ Funds withdrawn | positionId=${positionId} | issuance=${issuanceReturned.formatted} | collateral=${collateralWithdrawn.formatted}`
    )
  })
)

// ============================================================
// Rebalanced - Update position collateral and create activity
// ============================================================

StakingManager.Rebalanced.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const stakingManagerId = normalizeAddress(event.srcAddress)
    const userAddress = normalizeAddress(event.params.user_)
    const strategyAddress = normalizeAddress(event.params.strategy_)
    const timestamp = BigInt(event.block.timestamp)

    context.log.info(
      `[StakingManager.Rebalanced] Handler invoked | stakingManagerId=${stakingManagerId} | user=${userAddress} | strategy=${strategyAddress}`
    )

    const stakingContext = await loadStakingContext(context, stakingManagerId)
    if (!stakingContext) {
      context.log.warn(
        `[StakingManager.Rebalanced] StakingManager context not found | id=${stakingManagerId}`
      )
      return
    }

    const { manager, issuanceToken, reserveToken } = stakingContext
    const user = await getOrCreateAccount(context, event.params.user_)

    const positionId = `${userAddress}-${stakingManagerId}-${strategyAddress}`
    const position = await context.StakePosition.get(positionId)

    if (!position) {
      context.log.warn(`[StakingManager.Rebalanced] Position not found | positionId=${positionId}`)
      return
    }

    const additionalCollateral = formatAmount(
      event.params.additionalCollateralDeployed_,
      reserveToken.decimals
    )

    // Update position collateral
    const updatedPosition: StakePosition_t = {
      ...position,
      collateralDeployedRaw:
        position.collateralDeployedRaw + event.params.additionalCollateralDeployed_,
      collateralDeployedFormatted: formatAmount(
        position.collateralDeployedRaw + event.params.additionalCollateralDeployed_,
        reserveToken.decimals
      ).formatted,
      lastUpdatedAt: timestamp,
    }

    context.StakePosition.set(updatedPosition)

    // Create activity record
    const activityId = `${event.transaction.hash}-${event.logIndex}`
    const activity = {
      id: activityId,
      position_id: positionId,
      stakingManager_id: stakingManagerId,
      user_id: user.id,
      activityType: 'REBALANCE' as StakingActivityType_t,
      issuanceTokenAmountRaw: undefined,
      issuanceTokenAmountFormatted: undefined,
      collateralAmountRaw: event.params.additionalCollateralDeployed_,
      collateralAmountFormatted: additionalCollateral.formatted,
      yieldAmountRaw: undefined,
      yieldAmountFormatted: undefined,
      feeAmountRaw: undefined,
      feeAmountFormatted: undefined,
      receiver: undefined,
      timestamp,
      transactionHash: event.transaction.hash,
    }

    context.StakingActivity.set(activity)

    // Update StakingManager total collateral
    const updatedManager: StakingManager_t = {
      ...manager,
      totalCollateralDeployedRaw:
        manager.totalCollateralDeployedRaw + event.params.additionalCollateralDeployed_,
      totalCollateralDeployedFormatted: formatAmount(
        manager.totalCollateralDeployedRaw + event.params.additionalCollateralDeployed_,
        reserveToken.decimals
      ).formatted,
      lastUpdatedAt: timestamp,
    }

    context.StakingManager.set(updatedManager)

    context.log.info(
      `[StakingManager.Rebalanced] ✅ Position rebalanced | positionId=${positionId} | additionalCollateral=${additionalCollateral.formatted}`
    )
  })
)

// ============================================================
// LastFloorPriceUpdated - Update floor price on StakePosition
// ============================================================

StakingManager.LastFloorPriceUpdated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const stakingManagerId = normalizeAddress(event.srcAddress)
    const userAddress = normalizeAddress(event.params.user_)
    const strategyAddress = normalizeAddress(event.params.strategy_)
    const timestamp = BigInt(event.block.timestamp)

    context.log.info(
      `[StakingManager.LastFloorPriceUpdated] Handler invoked | stakingManagerId=${stakingManagerId} | user=${userAddress} | strategy=${strategyAddress}`
    )

    const stakingContext = await loadStakingContext(context, stakingManagerId)
    if (!stakingContext) {
      context.log.warn(
        `[StakingManager.LastFloorPriceUpdated] StakingManager context not found | id=${stakingManagerId}`
      )
      return
    }

    const positionId = `${userAddress}-${stakingManagerId}-${strategyAddress}`
    const position = await context.StakePosition.get(positionId)

    if (!position) {
      context.log.warn(
        `[StakingManager.LastFloorPriceUpdated] Position not found | id=${positionId}`
      )
      return
    }

    const { reserveToken } = stakingContext
    const floorPrice = formatAmount(event.params.newFloorPrice_, reserveToken.decimals)

    const updatedPosition: StakePosition_t = {
      ...position,
      floorPriceAtStakeRaw: event.params.newFloorPrice_,
      floorPriceAtStakeFormatted: floorPrice.formatted,
      lastUpdatedAt: timestamp,
    }

    context.StakePosition.set(updatedPosition)

    context.log.info(
      `[StakingManager.LastFloorPriceUpdated] ✅ Floor price updated | positionId=${positionId} | newFloorPrice=${floorPrice.formatted}`
    )
  })
)

// ============================================================
// Helper Functions
// ============================================================

type StakingContext = {
  manager: StakingManager_t
  issuanceToken: Token_t
  reserveToken: Token_t
}

async function loadStakingContext(
  context: handlerContext,
  stakingManagerId: string
): Promise<StakingContext | null> {
  const manager = await context.StakingManager.get(stakingManagerId)
  if (!manager) {
    return null
  }

  // Get the market to find the issuance token
  const market = await context.Market.get(manager.market_id)
  if (!market) {
    return null
  }

  const issuanceToken = await context.Token.get(market.issuanceToken_id)
  if (!issuanceToken) {
    return null
  }

  const reserveToken = await context.Token.get(market.reserveToken_id)
  if (!reserveToken) {
    return null
  }

  return { manager, issuanceToken, reserveToken }
}

function decodeStakingPerformanceFee(
  configData: `0x${string}`,
  logger: { warn: (message: string) => void }
): bigint {
  try {
    const [performanceFeeBps] = decodeAbiParameters(STAKING_CONFIG_PARAMS, configData)
    return performanceFeeBps
  } catch {
    logger.warn(
      `[StakingManager.ModuleInitialized] Unable to decode performance fee from configData; defaulting to 0`
    )
    return 0n
  }
}
