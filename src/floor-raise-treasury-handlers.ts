/**
 * @description Handlers for FloorRaiseTreasury_v1.
 *
 * The treasury is registered as a contract source in config.yaml but its address is
 * only known at deploy time. Envio auto-tracks any emitter address; the handler
 * creates the entity on first sight if it does not exist yet.
 */

import type { FloorRaiseTreasury_t } from '../generated/src/db/Entities.gen'
import { FloorRaiseTreasury } from '../generated/src/Handlers.gen'
import {
  formatAmount,
  getMarketIdForModule,
  getOrCreateToken,
  handlerErrorWrapper,
  normalizeAddress,
} from './helpers'

async function getOrCreateFloorRaiseTreasury(
  context: Parameters<
    Parameters<typeof FloorRaiseTreasury.ThresholdUpdated.handler>[0]
  >[0]['context'],
  params: {
    id: string
    marketId: string
    floor: string
    timestamp: bigint
  }
): Promise<FloorRaiseTreasury_t> {
  const existing = await context.FloorRaiseTreasury.get(params.id)
  if (existing) return existing

  const created: FloorRaiseTreasury_t = {
    id: params.id,
    market_id: params.marketId,
    address: params.id,
    floor: params.floor,
    thresholdRaw: 0n,
    thresholdFormatted: '0',
    accumulatedRaw: 0n,
    accumulatedFormatted: '0',
    totalRaisedCount: 0n,
    lastRaiseAttemptAt: undefined,
    lastRaiseAttemptSuccess: undefined,
    createdAt: params.timestamp,
    lastUpdatedAt: params.timestamp,
  }
  context.FloorRaiseTreasury.set(created)
  return created
}

FloorRaiseTreasury.ModuleInitialized.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const id = normalizeAddress(event.srcAddress)
    const marketId = await getMarketIdForModule(context, id)
    if (!marketId) {
      context.log.warn(
        `[FloorRaiseTreasury.ModuleInitialized] Unable to resolve market | treasury=${id} | tx=${event.transaction.hash}`
      )
      return
    }

    await getOrCreateFloorRaiseTreasury(context, {
      id,
      marketId,
      floor: normalizeAddress(event.params.floor),
      timestamp: BigInt(event.block.timestamp),
    })

    context.log.info(
      `[FloorRaiseTreasury.ModuleInitialized] ✅ Treasury indexed | treasury=${id} | marketId=${marketId}`
    )
  })
)

FloorRaiseTreasury.ThresholdUpdated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const id = normalizeAddress(event.srcAddress)
    const marketId = await getMarketIdForModule(context, id)
    if (!marketId) {
      context.log.warn(
        `[FloorRaiseTreasury.ThresholdUpdated] Unable to resolve market | treasury=${id} | tx=${event.transaction.hash}`
      )
      return
    }

    const timestamp = BigInt(event.block.timestamp)
    const treasury = await getOrCreateFloorRaiseTreasury(context, {
      id,
      marketId,
      floor: '',
      timestamp,
    })

    // Thresholds are in collateral-token decimals; resolve via the market's reserve token.
    const market = await context.Market.get(marketId)
    const reserveTokenId = market?.reserveToken_id
    const reserveToken = reserveTokenId ? await context.Token.get(reserveTokenId) : undefined
    const decimals = reserveToken?.decimals ?? 18

    const newThresholdRaw = event.params.newThreshold_
    const thresholdFormatted = formatAmount(newThresholdRaw, decimals).formatted

    context.FloorRaiseTreasury.set({
      ...treasury,
      thresholdRaw: newThresholdRaw,
      thresholdFormatted,
      lastUpdatedAt: timestamp,
    })

    context.log.info(
      `[FloorRaiseTreasury.ThresholdUpdated] ✅ Threshold set | treasury=${id} | oldThreshold=${event.params.oldThreshold_} | newThreshold=${newThresholdRaw}`
    )
  })
)

FloorRaiseTreasury.FloorRaiseAttempted.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const id = normalizeAddress(event.srcAddress)
    const marketId = await getMarketIdForModule(context, id)
    if (!marketId) {
      context.log.warn(
        `[FloorRaiseTreasury.FloorRaiseAttempted] Unable to resolve market | treasury=${id} | tx=${event.transaction.hash}`
      )
      return
    }

    const timestamp = BigInt(event.block.timestamp)
    const treasury = await getOrCreateFloorRaiseTreasury(context, {
      id,
      marketId,
      floor: '',
      timestamp,
    })

    const market = await context.Market.get(marketId)
    const reserveToken = market?.reserveToken_id
      ? await context.Token.get(market.reserveToken_id)
      : undefined
    const decimals = reserveToken?.decimals ?? 18

    const amountRaw = event.params.amount_
    const amountFormatted = formatAmount(amountRaw, decimals).formatted
    const success = event.params.success_

    const attemptId = `${event.transaction.hash}-${event.logIndex}`
    context.FloorRaiseAttempt.set({
      id: attemptId,
      treasury_id: id,
      market_id: marketId,
      amountRaw,
      amountFormatted,
      success,
      timestamp,
      transactionHash: event.transaction.hash,
    })

    // On success the raise consumed the accumulated balance; reset the snapshot.
    // On failure the balance stays, so leave accumulatedRaw untouched.
    context.FloorRaiseTreasury.set({
      ...treasury,
      accumulatedRaw: success ? 0n : treasury.accumulatedRaw,
      accumulatedFormatted: success ? '0' : treasury.accumulatedFormatted,
      totalRaisedCount: success ? treasury.totalRaisedCount + 1n : treasury.totalRaisedCount,
      lastRaiseAttemptAt: timestamp,
      lastRaiseAttemptSuccess: success,
      lastUpdatedAt: timestamp,
    })

    context.log.info(
      `[FloorRaiseTreasury.FloorRaiseAttempted] ${success ? '✅ raised' : '⚠️ failed'} | treasury=${id} | amount=${amountFormatted}`
    )
  })
)
