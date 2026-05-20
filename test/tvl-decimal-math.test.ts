/**
 * Tests for cross-market TVL / market-cap aggregation math.
 *
 * Regression: the global TVL aggregator previously did `(supply * price) / 1e18`,
 * which happens to work only when issuance-decimals + reserve-decimals === 36
 * (e.g. 18 + 18). For markets with a 6-decimal reserve (USDC) and 18-decimal
 * issuance the result was off by 1e12 — and once summed across markets with
 * different reserve currencies the figure became gibberish.
 *
 * The fix uses `normalizeAmount(supply * price, D_iss + D_res, 18)` so every
 * market's contribution lands at the same 18-decimal scale before summing.
 */

import assert from 'assert'

import { computeReserveValueAt18 } from '../src/helpers/misc'

const WAD = 10n ** 18n
const ONE_USDC = 10n ** 6n

describe('computeReserveValueAt18', () => {
  it('18-decimal issuance + 18-decimal reserve: 100 tokens at 0.5 reserve each = 50 (WAD)', () => {
    // supply = 100 tokens at 18d, price = 0.5 reserve at 18d
    const supply = 100n * WAD
    const price = WAD / 2n
    const tvl = computeReserveValueAt18(supply, price, 18, 18)
    assert.strictEqual(tvl, 50n * WAD)
  })

  it('18-decimal issuance + 6-decimal reserve (USDC): 100 tokens at 0.5 USDC each = 50 (WAD)', () => {
    // supply = 100 tokens at 18d, price = 0.5 USDC at 6d
    const supply = 100n * WAD
    const price = ONE_USDC / 2n // 500_000
    const tvl = computeReserveValueAt18(supply, price, 18, 6)
    assert.strictEqual(tvl, 50n * WAD)
  })

  it('6-decimal issuance + 6-decimal reserve: 100 tokens at 0.5 reserve each = 50 (WAD)', () => {
    const supply = 100n * ONE_USDC
    const price = ONE_USDC / 2n
    const tvl = computeReserveValueAt18(supply, price, 6, 6)
    assert.strictEqual(tvl, 50n * WAD)
  })

  it('matches the broken old math only for the 18+18 edge case', () => {
    const supply = 100n * WAD
    const price = WAD / 2n
    const oldMath = (supply * price) / WAD
    assert.strictEqual(oldMath, computeReserveValueAt18(supply, price, 18, 18))
  })

  it('the broken old math is off by 1e12 for 18-decimal issuance + 6-decimal reserve', () => {
    // Regression demo: the OLD `/ 1e18` formula returned a value 1e12x too small.
    const supply = 100n * WAD
    const price = ONE_USDC / 2n
    const oldMath = (supply * price) / WAD
    const fixed = computeReserveValueAt18(supply, price, 18, 6)
    assert.strictEqual(fixed / oldMath, 10n ** 12n)
  })

  it('sums two markets at a consistent 18-decimal scale', () => {
    // Market A: USDC reserve, 100 tokens at 0.5 USDC → $50.
    const tvlA = computeReserveValueAt18(100n * WAD, ONE_USDC / 2n, 18, 6)
    // Market B: WETH reserve, 10 tokens at 2.0 WETH → 20 WETH.
    const tvlB = computeReserveValueAt18(10n * WAD, 2n * WAD, 18, 18)
    const total = tvlA + tvlB
    // Each contribution is at 18 decimals; their sum is comparable in scale
    // (semantic cross-currency mixing is still up to a USD oracle elsewhere).
    assert.strictEqual(tvlA, 50n * WAD)
    assert.strictEqual(tvlB, 20n * WAD)
    assert.strictEqual(total, 70n * WAD)
  })

  it('returns 0 when supply is 0', () => {
    assert.strictEqual(computeReserveValueAt18(0n, WAD, 18, 18), 0n)
  })

  it('returns 0 when price is 0', () => {
    assert.strictEqual(computeReserveValueAt18(WAD, 0n, 18, 18), 0n)
  })
})
