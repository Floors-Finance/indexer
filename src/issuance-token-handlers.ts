// Issuance token Transfer handler for Floor Markets DeFi Platform
// On every ERC20 transfer of an issuance token, fetches the latest price
// from the bonding curve via RPC and updates the Market entity.

import { ERC20IssuanceToken } from '../generated/src/Handlers.gen'
import {
  fetchContractURIEffect,
  fetchFloorPricingEffect,
  formatAmount,
  handlerErrorWrapper,
  normalizeAddress,
  parseFloorPricingResult,
} from './helpers'
import { issuanceTokenToMarketId } from './issuance-token-registry'

ERC20IssuanceToken.ContractURIUpdated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const tokenAddress = normalizeAddress(event.srcAddress)
    const token = await context.Token.get(tokenAddress)
    if (!token) {
      context.log.warn(
        `[ERC20Issuance.ContractURIUpdated] Token not yet indexed | token=${tokenAddress} | tx=${event.transaction.hash}`
      )
      return
    }

    // ERC-7572 events carry no data — pull the new URI via RPC.
    const result = await fetchContractURIEffect(context.effect)({
      chainId: event.chainId,
      tokenAddress,
    })
    const uri = result?.uri ?? ''

    context.Token.set({ ...token, contractURI: uri })

    context.log.info(
      `[ERC20Issuance.ContractURIUpdated] ✅ contractURI set | token=${tokenAddress} | uri=${uri}`
    )
  })
)

ERC20IssuanceToken.Transfer.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const issuanceTokenAddress = normalizeAddress(event.srcAddress)

    // Reverse-lookup: issuance token → market ID (in-memory, rebuilt on resync)
    const marketId = issuanceTokenToMarketId.get(issuanceTokenAddress)
    if (!marketId) {
      // Token not yet registered (e.g. minted before IssuanceTokenSet was processed)
      return
    }

    const market = await context.Market.get(marketId)
    if (!market) {
      context.log.warn(
        `[IssuanceToken.Transfer] Market not found | issuanceToken=${issuanceTokenAddress} | marketId=${marketId}`
      )
      return
    }

    const reserveToken = await context.Token.get(market.reserveToken_id)
    if (!reserveToken) {
      context.log.warn(`[IssuanceToken.Transfer] Reserve token not found | marketId=${market.id}`)
      return
    }

    // ModuleRegistry.floor is the bonding curve address for this market
    const registry = await context.ModuleRegistry.get(marketId)
    if (!registry?.floor) {
      context.log.warn(`[IssuanceToken.Transfer] Floor address not found | marketId=${marketId}`)
      return
    }

    // Fetch fresh price from the bonding curve
    const pricingResult = await fetchFloorPricingEffect(context.effect)({
      chainId: event.chainId,
      floorAddress: registry.floor,
    })

    if (!pricingResult) {
      context.log.warn(`[IssuanceToken.Transfer] Price fetch failed | floor=${registry.floor}`)
      return
    }

    const parsed = parseFloorPricingResult(pricingResult)

    const buyPriceRaw = parsed.buyPrice ?? market.currentPriceRaw
    const floorPriceRaw = parsed.floorPrice ?? market.floorPriceRaw

    const updatedMarket = {
      ...market,
      currentPriceRaw: buyPriceRaw,
      currentPriceFormatted: formatAmount(buyPriceRaw, reserveToken.decimals).formatted,
      floorPriceRaw,
      floorPriceFormatted: formatAmount(floorPriceRaw, reserveToken.decimals).formatted,
      buyFeeBps: parsed.buyFeeBps ?? market.buyFeeBps,
      sellFeeBps: parsed.sellFeeBps ?? market.sellFeeBps,
      lastUpdatedAt: BigInt(event.block.timestamp),
    }

    context.Market.set(updatedMarket)

    context.log.info(
      `[IssuanceToken.Transfer] ✅ Price updated | market=${market.id} | buyPrice=${updatedMarket.currentPriceFormatted} | floor=${updatedMarket.floorPriceFormatted} | from=${normalizeAddress(event.params.from)} | to=${normalizeAddress(event.params.to)}`
    )
  })
)
