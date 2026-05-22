import type { handlerContext } from 'generated'
import type { Market_t, PreSaleContract_t, Token_t } from 'generated/src/db/Entities.gen'
import { decodeAbiParameters } from 'viem'

import { formatAmount, normalizeAddress } from './misc'
import { getOrCreateToken } from './token'
import {
  buildUpdatedUserMarketPosition,
  commitUserMarketPosition,
  getOrCreateAccount,
  getOrCreateUserMarketPosition,
} from './user'

export const PRESALE_LOG_PREFIX = '[Presale]'

export type PresaleContext = {
  presale: PreSaleContract_t
  marketId: string
  market?: Market_t
  saleToken?: Token_t
  purchaseToken?: Token_t
  timestamp: bigint
}

type ParticipationArgs = {
  userAddress: string
  depositRaw: bigint
  mintedRaw: bigint
  leverage: bigint
  positionId?: bigint
}

/**
 * Resolve the presale contract, market, and token metadata for a module.
 * Returns null if the presale entity has not been registered yet.
 */
export async function resolvePresaleContext(
  context: handlerContext,
  params: { presaleAddress: string; chainId: number; timestamp: bigint }
): Promise<PresaleContext | null> {
  const normalizedAddress = normalizeAddress(params.presaleAddress)
  const presale = await context.PreSaleContract.get(normalizedAddress)

  if (!presale) {
    context.log.warn(
      `[Presale] Missing PreSaleContract entity | address=${normalizedAddress} | action=reindex?`
    )
    return null
  }

  if (!presale.market_id) {
    context.log.error(
      `[Presale] PreSaleContract missing market reference | presale=${normalizedAddress}`
    )
    return null
  }

  const market = await context.Market.get(presale.market_id)

  const saleToken = presale.saleToken_id.startsWith('0x')
    ? await getOrCreateToken(context, params.chainId, presale.saleToken_id)
    : undefined
  const purchaseToken = presale.purchaseToken_id.startsWith('0x')
    ? await getOrCreateToken(context, params.chainId, presale.purchaseToken_id)
    : undefined

  return {
    presale,
    market,
    saleToken,
    purchaseToken,
    marketId: presale.market_id,
    timestamp: params.timestamp,
  }
}

export async function loadPresaleContextOrWarn(
  context: handlerContext,
  event: { srcAddress: string; chainId: number; block: { timestamp: number } },
  handlerName: string
): Promise<PresaleContext | null> {
  const timestamp = BigInt(event.block.timestamp)
  const presaleContext = await resolvePresaleContext(context, {
    presaleAddress: event.srcAddress,
    chainId: event.chainId,
    timestamp,
  })

  if (!presaleContext) {
    context.log.error(
      `${PRESALE_LOG_PREFIX} ${handlerName} aborted - presale not registered | presale=${event.srcAddress} | action=reindex`
    )
    return null
  }

  return presaleContext
}

export function applyPresalePatch(
  presale: PreSaleContract_t,
  patch: Partial<PreSaleContract_t>,
  timestamp: bigint
): PreSaleContract_t {
  return {
    ...presale,
    ...patch,
    lastUpdatedAt: timestamp,
  }
}

export async function handleParticipation(
  context: handlerContext,
  event: {
    transaction: { hash: string }
    logIndex: number
    srcAddress: string
    chainId: number
    block: { timestamp: number }
  },
  args: ParticipationArgs,
  handlerName: string
) {
  const presaleContext = await loadPresaleContextOrWarn(context, event, handlerName)
  if (!presaleContext) return

  const { presale, marketId, saleToken, purchaseToken, timestamp } = presaleContext

  const account = await getOrCreateAccount(context, args.userAddress)

  const depositDecimals = purchaseToken?.decimals ?? 18
  const mintedDecimals = saleToken?.decimals ?? 18
  const depositAmount = formatAmount(args.depositRaw, depositDecimals)
  const mintedAmount = formatAmount(args.mintedRaw, mintedDecimals)
  const participationId = `${event.transaction.hash}-${event.logIndex}`

  context.PresaleParticipation.set({
    id: participationId,
    user_id: account.id,
    presale_id: presale.id,
    positionId: args.positionId,
    depositAmountRaw: args.depositRaw,
    depositAmountFormatted: depositAmount.formatted,
    mintedAmountRaw: args.mintedRaw,
    mintedAmountFormatted: mintedAmount.formatted,
    loopCount: args.leverage,
    leverage: args.leverage,
    timestamp,
    transactionHash: event.transaction.hash,
  })

  const nextTotalRaisedRaw = presale.totalRaisedRaw + args.depositRaw
  const nextTotalRaisedFormatted = formatAmount(nextTotalRaisedRaw, depositDecimals).formatted
  const nextTotalMintedRaw = presale.totalMintedRaw + args.mintedRaw
  const nextTotalMintedFormatted = formatAmount(nextTotalMintedRaw, mintedDecimals).formatted

  const updatedPresale: PreSaleContract_t = {
    ...presale,
    totalRaisedRaw: nextTotalRaisedRaw,
    totalRaisedFormatted: nextTotalRaisedFormatted,
    totalMintedRaw: nextTotalMintedRaw,
    totalMintedFormatted: nextTotalMintedFormatted,
    totalParticipants: presale.totalParticipants + 1n,
    maxLeverage: args.leverage > presale.maxLeverage ? args.leverage : presale.maxLeverage,
    lastUpdatedAt: timestamp,
  }
  context.PreSaleContract.set(updatedPresale)

  const userPosition = await getOrCreateUserMarketPosition(
    context,
    account.id,
    marketId,
    saleToken?.decimals,
    timestamp
  )

  const updatedPosition = buildUpdatedUserMarketPosition(userPosition, {
    presaleDepositDelta: args.depositRaw,
    presaleLeverage: args.leverage,
    issuanceTokenDecimals: saleToken?.decimals ?? 18,
    reserveTokenDecimals: purchaseToken?.decimals ?? 18,
    timestamp,
  })
  commitUserMarketPosition(context, updatedPosition)

  context.log.info(
    `${PRESALE_LOG_PREFIX} ${handlerName} recorded | presale=${presale.id} | user=${account.id} | deposit=${depositAmount.formatted}`
  )
}

const PRESALE_CONFIG_PARAMS = [
  { type: 'address' },
  { type: 'uint16[]' },
  { type: 'uint64' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint256[]' },
] as const

export type DecodedPresaleConfig = {
  lendingFacility: string
  commissionBps: readonly bigint[]
  endTime: bigint
  globalIssuanceCapRaw: bigint
  perAddressIssuanceCapRaw: bigint
  /**
   * Flat price breakpoints shared across all leverage levels (post PR #126).
   * Retained the `Flat` suffix to avoid a schema rename; the array is now
   * always a single list.
   */
  priceBreakpointsFlat: bigint[]
  maxLeverage: number
}

export function decodePresaleConfig(encoded: string): DecodedPresaleConfig | null {
  if (!encoded || encoded === '0x') {
    return null
  }

  try {
    const [
      lendingFacility,
      commissionBps,
      endTime,
      globalIssuanceCapRaw,
      perAddressIssuanceCapRaw,
      priceBreakpoints,
    ] = decodeAbiParameters(PRESALE_CONFIG_PARAMS, encoded as `0x${string}`)

    const commissionValues = (commissionBps as readonly (number | bigint)[]).map((bps) =>
      BigInt(bps)
    )
    const priceBreakpointsValues = (priceBreakpoints as readonly (number | bigint)[]).map((value) =>
      BigInt(value)
    )

    // commissionBps includes the direct (non-leveraged) entry at index 0,
    // so maxLeverage = commissionBps.length - 1.
    const maxLeverage = commissionValues.length > 0 ? commissionValues.length - 1 : 0

    return {
      lendingFacility: normalizeAddress(lendingFacility as string),
      commissionBps: commissionValues,
      endTime: endTime as bigint,
      globalIssuanceCapRaw: globalIssuanceCapRaw as bigint,
      perAddressIssuanceCapRaw: perAddressIssuanceCapRaw as bigint,
      priceBreakpointsFlat: priceBreakpointsValues,
      maxLeverage,
    }
  } catch (error) {
    return null
  }
}
