import { createEffect, S } from 'envio'
import type { Abi } from 'viem'

import FLOOR_ABI from '../../abis/Floor_v1.json'
import { getPublicClient } from '../rpc-client'
import { wrapEffect } from './effects'

export type { FloorPricingResult } from './misc'
export { parseFloorPricingResult } from './misc'

// =============================================================================
// ABI Type Casts
// =============================================================================

const FLOOR_ABI_TYPED = FLOOR_ABI as Abi

// =============================================================================
// Floor Pricing Effect
// =============================================================================

export const fetchFloorPricingEffect = wrapEffect(
  createEffect(
    {
      name: 'fetchFloorPricing',
      input: { chainId: S.number, floorAddress: S.string },
      output: S.nullable(
        S.schema({
          buyPrice: S.nullable(S.string),
          sellPrice: S.nullable(S.string),
          buyFeeBps: S.nullable(S.string),
          sellFeeBps: S.nullable(S.string),
          floorPrice: S.nullable(S.string),
        })
      ),
      rateLimit: { calls: 50, per: 'second' },
      cache: false, // Prices change frequently
    },
    async ({ input, context }) => {
      try {
        const client = getPublicClient(input.chainId)
        const target = input.floorAddress as `0x${string}`

        const response = await client.multicall({
          allowFailure: true,
          contracts: [
            { address: target, abi: FLOOR_ABI_TYPED, functionName: 'getStaticPriceForBuying' },
            { address: target, abi: FLOOR_ABI_TYPED, functionName: 'getStaticPriceForSelling' },
            { address: target, abi: FLOOR_ABI_TYPED, functionName: 'getBuyFee' },
            { address: target, abi: FLOOR_ABI_TYPED, functionName: 'getSellFee' },
            { address: target, abi: FLOOR_ABI_TYPED, functionName: 'getFloorPrice' },
          ],
        })

        type MulticallResult = { status: 'success'; result: bigint } | { status: 'failure' }
        const extractValue = (result: MulticallResult): string | undefined => {
          if (result.status !== 'success') return undefined
          return result.result.toString()
        }

        return {
          buyPrice: extractValue(response[0] as MulticallResult),
          sellPrice: extractValue(response[1] as MulticallResult),
          buyFeeBps: extractValue(response[2] as MulticallResult),
          sellFeeBps: extractValue(response[3] as MulticallResult),
          floorPrice: extractValue(response[4] as MulticallResult),
        }
      } catch {
        context.cache = false
        return undefined
      }
    }
  )
)

// =============================================================================
// Floor Helper Types & Functions
// =============================================================================
