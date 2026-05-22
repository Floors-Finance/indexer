import type { PreSaleContract_t } from '../generated/src/db/Entities.gen'
import { Presale } from '../generated/src/Handlers.gen'
import {
  applyPresalePatch,
  decodePresaleConfig,
  formatAmount,
  handleParticipation,
  handlerErrorWrapper,
  loadPresaleContextOrWarn,
  normalizeAddress,
  PRESALE_LOG_PREFIX,
} from './helpers'

// NOTE: PresaleBought is intentionally a no-op. Participation tracking is
// handled exclusively by the PositionCreated handler (which has positionId).
// Both events fire per purchase — handling both would double-count
// totalRaisedRaw, totalParticipants, and create duplicate participation records.
Presale.PresaleBought.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'PresaleBought')
    if (!presaleContext) return

    context.log.info(
      `${PRESALE_LOG_PREFIX} PresaleBought | presale=${presaleContext.presale.id} | buyer=${event.params.buyer_} | loopCount=${event.params.loopCount_} | totalMinted=${event.params.totalMinted_} | multiplier=${event.params.multiplier_}`
    )
  })
)

Presale.PositionCreated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    await handleParticipation(
      context,
      event,
      {
        userAddress: event.params.owner_,
        depositRaw: event.params.netAllocation_,
        mintedRaw: event.params.totalMinted_,
        leverage: event.params.loops_,
        positionId: event.params.positionId_,
      },
      'PositionCreated'
    )
  })
)

Presale.DirectTokensClaimed.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'DirectTokensClaimed')
    if (!presaleContext) return

    const { presale, saleToken, timestamp } = presaleContext
    const saleDecimals = saleToken?.decimals ?? 18
    const amount = formatAmount(event.params.amount_, saleDecimals)

    context.PresaleClaim.set({
      id: `${event.transaction.hash}-${event.logIndex}`,
      presale_id: normalizeAddress(presale.id),
      positionId: event.params.positionId_,
      claimType: 'DIRECT',
      amountRaw: event.params.amount_,
      amountFormatted: amount.formatted,
      trancheIndex: undefined,
      loanId: undefined,
      timestamp,
      transactionHash: event.transaction.hash,
    })

    context.log.info(
      `${PRESALE_LOG_PREFIX} DirectTokensClaimed | presale=${presale.id} | position=${event.params.positionId_.toString()} | amount=${amount.formatted}`
    )
  })
)

Presale.TrancheClaimed.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'TrancheClaimed')
    if (!presaleContext) return

    const { presale, saleToken, timestamp } = presaleContext
    const saleDecimals = saleToken?.decimals ?? 18
    const zeroAmount = formatAmount(0n, saleDecimals)

    context.PresaleClaim.set({
      id: `${event.transaction.hash}-${event.logIndex}`,
      presale_id: normalizeAddress(presale.id),
      positionId: event.params.positionId_,
      claimType: 'TRANCHE',
      amountRaw: 0n,
      amountFormatted: zeroAmount.formatted,
      trancheIndex: event.params.trancheIndex_,
      loanId: event.params.loanId_,
      timestamp,
      transactionHash: event.transaction.hash,
    })

    context.log.info(
      `${PRESALE_LOG_PREFIX} TrancheClaimed | presale=${presale.id} | position=${event.params.positionId_.toString()} | tranche=${event.params.trancheIndex_.toString()}`
    )
  })
)

Presale.CapsUpdated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'CapsUpdated')
    if (!presaleContext) return

    // Caps are on issuance tokens (saleToken), not purchase tokens
    const { presale, saleToken, timestamp } = presaleContext
    const issuanceDecimals = saleToken?.decimals ?? 18
    const nextGlobal = formatAmount(event.params.globalCap_, issuanceDecimals)
    const nextPerAddress = formatAmount(event.params.perAddressCap_, issuanceDecimals)

    context.PreSaleContract.set(
      applyPresalePatch(
        presale,
        {
          globalIssuanceCapRaw: event.params.globalCap_,
          globalIssuanceCapFormatted: nextGlobal.formatted,
          perAddressIssuanceCapRaw: event.params.perAddressCap_,
          perAddressIssuanceCapFormatted: nextPerAddress.formatted,
        },
        timestamp
      )
    )
  })
)

Presale.BaseCommissionUpdated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'BaseCommissionUpdated')
    if (!presaleContext) return

    const { presale, timestamp } = presaleContext
    const commissionBps = Array.from(event.params.baseCommissionBps_)
    context.PreSaleContract.set(applyPresalePatch(presale, { commissionBps }, timestamp))
  })
)

Presale.PriceBreakpointsSet.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'PriceBreakpointsSet')
    if (!presaleContext) return
    const { presale, timestamp } = presaleContext

    // Post PR #126: priceBreakpoints_ is a flat uint256[] shared across leverage levels.
    const priceBreakpointsFlat: bigint[] = Array.from(event.params.priceBreakpoints_)
    context.PreSaleContract.set(applyPresalePatch(presale, { priceBreakpointsFlat }, timestamp))
  })
)

Presale.PresaleStateSet.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'PresaleStateSet')
    if (!presaleContext) return
    const { presale, timestamp } = presaleContext

    context.PreSaleContract.set(
      applyPresalePatch(presale, { currentState: Number(event.params.state_) }, timestamp)
    )
  })
)

Presale.EndTimestampSet.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'EndTimestampSet')
    if (!presaleContext) return
    const { presale, timestamp } = presaleContext

    context.PreSaleContract.set(
      applyPresalePatch(presale, { endTime: event.params.endTimestamp_ }, timestamp)
    )
  })
)

Presale.CreditFacilitySet.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'CreditFacilitySet')
    if (!presaleContext) return
    const { presale, timestamp } = presaleContext

    const lendingFacility = normalizeAddress(event.params.creditFacility_)
    context.PreSaleContract.set(applyPresalePatch(presale, { lendingFacility }, timestamp))
  })
)

Presale.MerkleRootUpdated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'MerkleRootUpdated')
    if (!presaleContext) return
    const { presale, timestamp } = presaleContext

    context.PreSaleContract.set(
      applyPresalePatch(
        presale,
        {
          merkleRoot: event.params.newRoot_,
        },
        timestamp
      )
    )

    context.log.info(
      `${PRESALE_LOG_PREFIX} MerkleRootUpdated | presale=${presale.id} | newRoot=${event.params.newRoot_}`
    )
  })
)

Presale.MerkleWhitelistRegistered.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(
      context,
      event,
      'MerkleWhitelistRegistered'
    )
    if (!presaleContext) return
    const { presale, timestamp } = presaleContext

    const nextWhitelistSize = presale.whitelistSize + 1n

    context.PreSaleContract.set(
      applyPresalePatch(
        presale,
        {
          whitelistSize: nextWhitelistSize,
        },
        timestamp
      )
    )

    context.log.info(
      `${PRESALE_LOG_PREFIX} MerkleWhitelistRegistered | presale=${presale.id} | account=${event.params.account_} | totalRegistered=${nextWhitelistSize}`
    )
  })
)

Presale.PresaleReopened.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'PresaleReopened')
    if (!presaleContext) return
    const { presale, timestamp } = presaleContext

    context.PreSaleContract.set(
      applyPresalePatch(presale, { currentState: Number(event.params.newState_) }, timestamp)
    )

    context.log.info(
      `${PRESALE_LOG_PREFIX} PresaleReopened | presale=${presale.id} | from=${event.params.previousState_} | to=${event.params.newState_}`
    )
  })
)

Presale.DecayDurationUpdated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'DecayDurationUpdated')
    if (!presaleContext) return
    const { presale, timestamp } = presaleContext

    context.PreSaleContract.set(
      applyPresalePatch(
        presale,
        {
          decayDuration: event.params.newDuration_,
        },
        timestamp
      )
    )

    context.log.info(
      `${PRESALE_LOG_PREFIX} DecayDurationUpdated | presale=${presale.id} | oldDuration=${event.params.oldDuration_} | newDuration=${event.params.newDuration_}`
    )
  })
)

Presale.InitialMultiplierUpdated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(
      context,
      event,
      'InitialMultiplierUpdated'
    )
    if (!presaleContext) return
    const { presale, timestamp } = presaleContext

    context.PreSaleContract.set(
      applyPresalePatch(
        presale,
        {
          initialMultiplier: BigInt(event.params.newMultiplier_),
        },
        timestamp
      )
    )

    context.log.info(
      `${PRESALE_LOG_PREFIX} InitialMultiplierUpdated | presale=${presale.id} | oldMultiplier=${event.params.oldMultiplier_} | newMultiplier=${event.params.newMultiplier_}`
    )
  })
)

Presale.FeeMultiplierDecayStarted.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(
      context,
      event,
      'FeeMultiplierDecayStarted'
    )
    if (!presaleContext) return
    const { presale, timestamp } = presaleContext

    context.PreSaleContract.set(
      applyPresalePatch(
        presale,
        {
          decayStartTime: event.params.startTime_,
        },
        timestamp
      )
    )

    context.log.info(
      `${PRESALE_LOG_PREFIX} FeeMultiplierDecayStarted | presale=${presale.id} | startTime=${event.params.startTime_}`
    )
  })
)

Presale.FeeMultiplierDecayReset.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'FeeMultiplierDecayReset')
    if (!presaleContext) return
    const { presale, timestamp } = presaleContext

    context.PreSaleContract.set(
      applyPresalePatch(
        presale,
        {
          decayStartTime: 0n,
        },
        timestamp
      )
    )

    context.log.info(`${PRESALE_LOG_PREFIX} FeeMultiplierDecayReset | presale=${presale.id}`)
  })
)

Presale.ModuleInitialized.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'ModuleInitialized')
    if (!presaleContext) return
    const { presale, purchaseToken, timestamp } = presaleContext

    const floorAddress = normalizeAddress(event.params.floor)

    let patch: Partial<PreSaleContract_t> = {
      market_id: floorAddress,
      authorizer: normalizeAddress(event.params.authorizer),
      feeTreasury: normalizeAddress(event.params.feeTreasury),
    }

    if (presale.startTime === 0n) {
      patch = { ...patch, startTime: timestamp }
    }

    const decodedConfig = decodePresaleConfig(event.params.configData)
    if (decodedConfig) {
      // globalIssuanceCap is a cap on issuance tokens (saleToken), not purchase tokens
      const { presale, saleToken } = presaleContext
      const issuanceDecimals = saleToken?.decimals ?? 18
      const globalCapAmount = formatAmount(decodedConfig.globalIssuanceCapRaw, issuanceDecimals)
      const perAddressCapAmount = formatAmount(
        decodedConfig.perAddressIssuanceCapRaw,
        issuanceDecimals
      )

      // Use calculated maxLeverage from commissionBps or priceBreakpoints
      // Note: We avoid RPC calls in indexer for performance/reliability
      // If maxLeverage is 0, it means no leverage is configured (direct purchases only)
      const maxLeverage = BigInt(decodedConfig.maxLeverage)

      patch = {
        ...patch,
        lendingFacility: decodedConfig.lendingFacility,
        endTime: decodedConfig.endTime,
        globalIssuanceCapRaw: decodedConfig.globalIssuanceCapRaw,
        globalIssuanceCapFormatted: globalCapAmount.formatted,
        perAddressIssuanceCapRaw: decodedConfig.perAddressIssuanceCapRaw,
        perAddressIssuanceCapFormatted: perAddressCapAmount.formatted,
        commissionBps: Array.from(decodedConfig.commissionBps),
        priceBreakpointsFlat: [...decodedConfig.priceBreakpointsFlat],
        maxLeverage,
      }
    }

    context.PreSaleContract.set(applyPresalePatch(presale, patch, timestamp))
  })
)

Presale.Initialized.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const presaleContext = await loadPresaleContextOrWarn(context, event, 'Initialized')
    if (!presaleContext) return
    const { presale, timestamp } = presaleContext

    context.PreSaleContract.set(applyPresalePatch(presale, {}, timestamp))
  })
)
