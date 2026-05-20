import { getAddress } from 'viem'

// ── Floor pricing types & parser ───────────────────────────────────────────
// Kept here (no Envio runtime deps) so tests can import without side-effects.

export type FloorPricingResult = {
  buyPrice?: bigint
  sellPrice?: bigint
  buyFeeBps?: bigint
  sellFeeBps?: bigint
  floorPrice?: bigint
}

/**
 * ERC20 reserve amounts use the token's `decimals()`.
 * Bonding-curve floor / buy / sell prices from the protocol are 1e18 fixed-point (WAD).
 */
export const FLOOR_PRICE_DECIMALS = 18

export function parseFloorPricingResult(
  effectResult:
    | {
        buyPrice?: string | null
        sellPrice?: string | null
        buyFeeBps?: string | null
        sellFeeBps?: string | null
        floorPrice?: string | null
      }
    | null
    | undefined
): FloorPricingResult {
  if (!effectResult) return {}
  return {
    buyPrice: effectResult.buyPrice ? BigInt(effectResult.buyPrice) : undefined,
    sellPrice: effectResult.sellPrice ? BigInt(effectResult.sellPrice) : undefined,
    buyFeeBps: effectResult.buyFeeBps ? BigInt(effectResult.buyFeeBps) : undefined,
    sellFeeBps: effectResult.sellFeeBps ? BigInt(effectResult.sellFeeBps) : undefined,
    floorPrice: effectResult.floorPrice ? BigInt(effectResult.floorPrice) : undefined,
  }
}

/**
 * Format a raw BigInt amount with decimals into Amount type
 * Example: formatAmount(9900000n, 18) -> { raw: 9900000n, formatted: "9.9" }
 */
export function formatAmount(raw: bigint, decimals: number): { raw: bigint; formatted: string } {
  const divisor = BigInt(10 ** decimals)
  const whole = raw / divisor
  const fractional = raw % divisor
  const fractionalStr = fractional.toString().padStart(decimals, '0')

  // Remove trailing zeros from fractional part
  const trimmedFractional = fractionalStr.replace(/0+$/, '')
  const formatted = trimmedFractional ? `${whole}.${trimmedFractional}` : whole.toString()

  return { raw, formatted }
}

/**
 * Extract module type from metadata title
 * Maps module titles to ModuleRegistry field names
 */
export function extractModuleType(
  title: string
): 'floor' | 'authorizer' | 'unknown' | 'creditFacility' | 'feeTreasury' | 'presale' | 'staking' {
  const lower = title.toLowerCase()

  if (lower.includes('creditfacility')) return 'creditFacility'
  if (lower.includes('treasury') || lower.includes('splitter')) return 'feeTreasury'
  if (lower.includes('presale')) return 'presale'
  if (lower.includes('staking')) return 'staking'
  if (lower.includes('floor') || lower.startsWith('bc')) return 'floor'

  const prefix = title.split('_')[0]
  const prefixMap: Record<'Floor' | 'AUT', 'floor' | 'authorizer'> = {
    Floor: 'floor',
    AUT: 'authorizer',
  }

  return prefixMap[prefix as keyof typeof prefixMap] || 'unknown'
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Resolve the canonical market ID for a module.
 * Prefer the orchestrator (market) address unless it is unset/zero.
 */
export function resolveMarketId(orchestrator: string, module: string): string {
  const normalizedModule = normalizeAddress(module)
  if (!orchestrator) {
    return normalizedModule
  }

  const normalizedOrchestrator = normalizeAddress(orchestrator)
  if (normalizedOrchestrator === ZERO_ADDRESS) {
    return normalizedModule
  }

  return normalizedOrchestrator
}

/**
 * Normalize a raw amount from one decimal precision to another.
 * Example: normalizeAmount(1000000n, 6, 18) -> 1000000000000000000n
 */
export function normalizeAmount(value: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return value
  if (fromDecimals > toDecimals) {
    return value / 10n ** BigInt(fromDecimals - toDecimals)
  }
  return value * 10n ** BigInt(toDecimals - fromDecimals)
}

/**
 * Reserve-currency value of a token bag at 18-decimal precision.
 *
 * `supplyRaw` is in issuance-token decimals; `priceRaw` is "reserve units per
 * issuance unit" expressed at reserve-token decimals (matches the convention
 * `formatAmount(price, reserveToken.decimals)` used across handlers). The raw
 * product lives in (D_iss + D_res) decimals — normalise to 18 so totals
 * across markets with different reserve currencies share a common scale.
 */
export function computeReserveValueAt18(
  supplyRaw: bigint,
  priceRaw: bigint,
  issuanceDecimals: number,
  reserveDecimals: number
): bigint {
  return normalizeAmount(supplyRaw * priceRaw, issuanceDecimals + reserveDecimals, 18)
}

export function normalizeAddress(address: string): string {
  if (!address || !address.startsWith('0x')) {
    return address
  }

  try {
    return getAddress(address as `0x${string}`)
  } catch {
    return address
  }
}
