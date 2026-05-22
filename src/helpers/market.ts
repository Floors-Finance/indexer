import type { handlerContext } from 'generated'
import type { Market_t, Token_t } from 'generated/src/db/Entities.gen'
import type { MarketStatus_t } from 'generated/src/db/Enums.gen'

import { formatAmount, normalizeAddress } from './misc'
import {
  decodeFloorSegmentSupply,
  fetchFloorSectionFromBCEffect,
  fetchInitialPriceFromBCEffect,
  fetchTokenAddressesFromBCEffect,
  getOrCreateToken,
} from './token'
import { getOrCreateAccount } from './user'

/**
 * Get or create Market entity
 * Creates it defensively if it doesn't exist (handles race conditions)
 * Note: Market contains both static config and dynamic state fields
 *
 * @param marketId The ID for the market (orchestrator/BC address)
 * @param bcAddress Optional BC module address to fetch token addresses from
 * @param chainId Chain ID for RPC calls
 */
export async function getOrCreateMarket(
  context: handlerContext,
  chainId: number,
  marketId: string,
  timestamp: bigint,
  reserveTokenId?: string,
  issuanceTokenId?: string,
  bcAddress?: `0x${string}`,
  creatorAddress?: string,
  factoryAddress?: string
): Promise<Market_t | null> {
  const normalizedMarketId = normalizeAddress(marketId)
  const normalizedCreator = creatorAddress ? normalizeAddress(creatorAddress) : normalizedMarketId
  const normalizedFactory = factoryAddress ? normalizeAddress(factoryAddress) : 'unknown-factory'

  let market = await context.Market.get(normalizedMarketId)

  // If market exists, return it
  if (market) {
    context.log.debug(
      `[getOrCreateMarket] Market hit | id=${normalizedMarketId} | reserveToken=${market.reserveToken_id} | issuanceToken=${market.issuanceToken_id}`
    )
    return market
  }

  context.log.info(
    `[getOrCreateMarket] Creating market | id=${normalizedMarketId} | bcAddress=${bcAddress || 'none'} | reserveToken=${reserveTokenId || 'fetching'} | issuanceToken=${issuanceTokenId || 'fetching'} | chainId=${chainId}`
  )

  // Create new market
  const creator = await getOrCreateAccount(context, normalizedCreator)

  // Try to fetch token addresses from BC contract if BC address provided
  let finalReserveTokenId = reserveTokenId
  let finalIssuanceTokenId = issuanceTokenId

  if ((!finalReserveTokenId || !finalIssuanceTokenId) && bcAddress) {
    context.log.debug(
      `[getOrCreateMarket] Fetching token addresses | bcAddress=${bcAddress} | chainId=${chainId}`
    )
    const tokenAddresses = await fetchTokenAddressesFromBCEffect(context.effect)({
      chainId,
      bcAddress,
    })
    if (tokenAddresses) {
      if (!finalReserveTokenId) finalReserveTokenId = tokenAddresses.reserveToken as `0x${string}`
      if (!finalIssuanceTokenId)
        finalIssuanceTokenId = tokenAddresses.issuanceToken as `0x${string}`
      context.log.info(
        `[getOrCreateMarket] ✅ Tokens resolved | reserveToken=${finalReserveTokenId} | issuanceToken=${finalIssuanceTokenId}`
      )
    } else {
      context.log.warn(
        `[getOrCreateMarket] ⚠️ Token fetch failed | bcAddress=${bcAddress} | using placeholders`
      )
    }
  }

  // Get or create tokens
  type TokenOrPlaceholder = Token_t | { id: string; name: string; symbol: string; decimals: number }
  let reserveToken: TokenOrPlaceholder
  let issuanceToken: TokenOrPlaceholder

  if (finalReserveTokenId) {
    reserveToken = await getOrCreateToken(context, chainId, finalReserveTokenId)
  } else {
    // Create placeholder token if no reserve token address
    reserveToken = {
      id: 'unknown-reserve',
      name: 'Unknown Reserve Token',
      symbol: 'UNKNOWN',
      decimals: 18,
    }
    context.log.warn(
      `[getOrCreateMarket] Reserve token placeholder used | marketId=${normalizedMarketId}`
    )
  }

  if (finalIssuanceTokenId) {
    issuanceToken = await getOrCreateToken(context, chainId, finalIssuanceTokenId)
  } else {
    // Create placeholder token if no issuance token address
    issuanceToken = {
      id: 'unknown-issuance',
      name: 'Unknown Issuance Token',
      symbol: 'UNKNOWN',
      decimals: 18,
    }
    context.log.warn(
      `[getOrCreateMarket] Issuance token placeholder used | marketId=${normalizedMarketId}`
    )
  }

  // Fetch initial price from bonding curve contract
  let initialPriceRaw = 0n
  let initialPriceFormatted = '0'
  if (bcAddress) {
    const priceResult = await fetchInitialPriceFromBCEffect(context.effect)({
      chainId,
      bcAddress,
    })
    if (priceResult) {
      initialPriceRaw = BigInt(priceResult.buyPriceRaw)
      initialPriceFormatted = formatAmount(initialPriceRaw, reserveToken.decimals).formatted
      context.log.info(
        `[getOrCreateMarket] ✅ Initial price fetched | price=${initialPriceFormatted} | raw=${initialPriceRaw}`
      )
    } else {
      context.log.warn(
        `[getOrCreateMarket] ⚠️ Initial price fetch failed | bcAddress=${bcAddress} | defaulting to 0`
      )
    }
  }

  // Fetch floor segment supply cap from bonding curve (static config)
  let floorSegmentSupplyRaw = 0n
  let floorSegmentSupplyFormatted = '0'
  if (bcAddress) {
    const floorSection = await fetchFloorSectionFromBCEffect(context.effect)({
      chainId,
      bcAddress,
    })
    if (floorSection) {
      floorSegmentSupplyRaw = decodeFloorSegmentSupply(floorSection.floorSectionHex)
      floorSegmentSupplyFormatted = formatAmount(
        floorSegmentSupplyRaw,
        issuanceToken.decimals
      ).formatted
      context.log.info(
        `[getOrCreateMarket] ✅ Floor segment supply fetched | supply=${floorSegmentSupplyFormatted} | raw=${floorSegmentSupplyRaw}`
      )
    } else {
      context.log.warn(
        `[getOrCreateMarket] ⚠️ Floor section fetch failed | bcAddress=${bcAddress} | defaulting to 0`
      )
    }
  }

  market = {
    id: normalizedMarketId,
    creator_id: creator.id,
    factory_id: normalizedFactory,
    reserveToken_id: reserveToken.id,
    issuanceToken_id: issuanceToken.id,
    // Static config fields
    initialFloorPriceRaw: 0n,
    initialFloorPriceFormatted: '0',
    tradingFeeBps: 0n,
    buyFeeBps: 0n,
    sellFeeBps: 0n,
    maxLTV: 0n,
    // Dynamic state fields
    currentPriceRaw: initialPriceRaw,
    currentPriceFormatted: initialPriceFormatted,
    floorPriceRaw: 0n,
    floorPriceFormatted: '0',
    totalSupplyRaw: 0n,
    totalSupplyFormatted: '0',
    marketSupplyRaw: 0n,
    marketSupplyFormatted: '0',
    floorSupplyRaw: 0n,
    floorSupplyFormatted: '0',
    floorSegmentSupplyRaw,
    floorSegmentSupplyFormatted,
    reserveBalanceRaw: 0n,
    reserveBalanceFormatted: '0',
    status: 'ACTIVE' as MarketStatus_t,
    isBuyOpen: false,
    isSellOpen: false,
    lastTradeTimestamp: 0n,
    lastElevationTimestamp: 0n,
    lastUpdatedAt: timestamp,
    createdAt: timestamp,
  }
  context.Market.set(market)

  context.log.info(
    `[getOrCreateMarket] ✅ Market created | id=${market.id} | reserveToken=${market.reserveToken_id} | issuanceToken=${market.issuanceToken_id}`
  )

  return market
}
