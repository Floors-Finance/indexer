// Credit facility event handlers for Floor Markets DeFi Platform

import type { handlerContext } from 'generated'

import type { CreditFacilityContract_t, Market_t, Token_t } from '../generated/src/db/Entities.gen'
import type { LoanStatus_t } from '../generated/src/db/Enums.gen'
import { CreditFacility } from '../generated/src/Handlers.gen'
import {
  applyFacilityDeltas,
  applyGlobalDebtDelta,
  buildUpdatedUserMarketPosition,
  commitUserMarketPosition,
  formatAmount,
  getOrCreateAccount,
  getOrCreateUserMarketPosition,
  handlerErrorWrapper,
  normalizeAddress,
} from './helpers'

type FacilityLtvEntry = {
  previousMaxLtv: bigint
  currentMaxLtv: bigint
}

const facilityLtvHistory = new Map<string, FacilityLtvEntry>()

CreditFacility.LoanCreated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const facilityId = normalizeAddress(event.srcAddress)
    const timestamp = BigInt(event.block.timestamp)
    const facilityContext = await loadFacilityContext(context, facilityId)

    if (!facilityContext) {
      context.log.warn(
        `[LoanCreated] Facility context missing | facilityId=${facilityId} | block=${event.block.number} | tx=${event.transaction.hash}`
      )
      return
    }

    const { facility, borrowToken, collateralToken } = facilityContext
    const borrower = await getOrCreateAccount(context, event.params.borrower_)
    const loanId = event.params.loanId_.toString()

    // Post PR #126: LoanCreated carries the full initial state inline.
    // loanAmount_ == remaining debt, lockedIssuanceTokens_ == locked collateral — no eth_call needed.
    const lockedCollateralRaw = event.params.lockedIssuanceTokens_
    const remainingDebtRaw = event.params.loanAmount_

    const borrowAmount = formatAmount(event.params.loanAmount_, borrowToken.decimals)
    const lockedCollateral = formatAmount(lockedCollateralRaw, collateralToken.decimals)
    const remainingDebt = formatAmount(remainingDebtRaw, borrowToken.decimals)

    const loan = {
      id: loanId,
      borrower_id: borrower.id,
      facility_id: facility.id,
      market_id: facility.market_id,
      lockedCollateralRaw,
      lockedCollateralFormatted: lockedCollateral.formatted,
      borrowAmountRaw: event.params.loanAmount_,
      borrowAmountFormatted: borrowAmount.formatted,
      originationFeeRaw: 0n,
      originationFeeFormatted: '0',
      remainingDebtRaw,
      remainingDebtFormatted: remainingDebt.formatted,
      floorPriceAtBorrowRaw: 0n,
      floorPriceAtBorrowFormatted: '0',
      status: 'ACTIVE' as LoanStatus_t,
      openedAt: timestamp,
      closedAt: undefined,
      lastUpdatedAt: timestamp,
      transactionHash: event.transaction.hash,
    }
    context.Loan.set(loan)

    const updatedFacility = applyFacilityDeltas({
      facility,
      borrowTokenDecimals: borrowToken.decimals,
      collateralTokenDecimals: collateralToken.decimals,
      timestamp,
      volumeDeltaRaw: event.params.loanAmount_,
      debtDeltaRaw: event.params.loanAmount_,
      lockedCollateralDeltaRaw: lockedCollateralRaw,
      loanCountDelta: 1n,
    })
    context.CreditFacilityContract.set(updatedFacility)

    await applyGlobalDebtDelta(context, {
      debtDeltaRaw: event.params.loanAmount_,
      collateralDeltaRaw: lockedCollateralRaw,
      debtTokenDecimals: borrowToken.decimals,
      collateralTokenDecimals: collateralToken.decimals,
      timestamp,
    })

    const position = await getOrCreateUserMarketPosition(
      context,
      borrower.id,
      facility.market_id,
      collateralToken.decimals,
      timestamp
    )
    const updatedPosition = buildUpdatedUserMarketPosition(position, {
      totalDebtDelta: event.params.loanAmount_,
      lockedCollateralDelta: lockedCollateralRaw,
      issuanceTokenDecimals: collateralToken.decimals,
      reserveTokenDecimals: borrowToken.decimals,
      timestamp,
    })
    commitUserMarketPosition(context, updatedPosition)

    recordLoanStatusHistory(context, {
      loanId,
      status: 'ACTIVE',
      remainingDebtRaw,
      lockedCollateralRaw,
      borrowTokenDecimals: borrowToken.decimals,
      collateralTokenDecimals: collateralToken.decimals,
      timestamp,
      transactionHash: event.transaction.hash,
      logIndex: event.logIndex,
    })

    context.log.info(
      `[LoanCreated] ✅ Loan created | loanId=${loanId} | borrower=${borrower.id} | amount=${borrowAmount.formatted}`
    )
  })
)

CreditFacility.LoanRebalanced.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const facilityId = normalizeAddress(event.srcAddress)
    const timestamp = BigInt(event.block.timestamp)
    const facilityContext = await loadFacilityContext(context, facilityId)

    if (!facilityContext) {
      context.log.warn(
        `[LoanRebalanced] Facility context missing | facilityId=${facilityId} | block=${event.block.number} | tx=${event.transaction.hash}`
      )
      return
    }

    const { facility, borrowToken, collateralToken } = facilityContext
    const loanId = event.params.loanId_.toString()
    const loan = await context.Loan.get(loanId)

    if (!loan) {
      context.log.warn(
        `[LoanRebalanced] Loan not indexed | loanId=${loanId} | facilityId=${facilityId} | tx=${event.transaction.hash}`
      )
      return
    }

    // Post PR #126: LoanRebalanced emits released collateral delta + new remaining loan.
    const releasedAmount = event.params.releasedCollateralAmount_
    const newLockedCollateralRaw =
      loan.lockedCollateralRaw > releasedAmount ? loan.lockedCollateralRaw - releasedAmount : 0n
    const lockedCollateralDelta = -releasedAmount
    const lockedCollateral = formatAmount(newLockedCollateralRaw, collateralToken.decimals)

    const newRemainingDebtRaw = event.params.newRemainingLoanAmount_
    const newRemainingDebt = formatAmount(newRemainingDebtRaw, borrowToken.decimals)
    const debtDelta = newRemainingDebtRaw - loan.remainingDebtRaw

    const updatedLoan = {
      ...loan,
      lockedCollateralRaw: newLockedCollateralRaw,
      lockedCollateralFormatted: lockedCollateral.formatted,
      remainingDebtRaw: newRemainingDebtRaw,
      remainingDebtFormatted: newRemainingDebt.formatted,
      lastUpdatedAt: timestamp,
    }
    context.Loan.set(updatedLoan)

    const updatedFacility = applyFacilityDeltas({
      facility,
      borrowTokenDecimals: borrowToken.decimals,
      collateralTokenDecimals: collateralToken.decimals,
      timestamp,
      lockedCollateralDeltaRaw: lockedCollateralDelta,
      debtDeltaRaw: debtDelta,
    })
    context.CreditFacilityContract.set(updatedFacility)

    await applyGlobalDebtDelta(context, {
      debtDeltaRaw: debtDelta,
      collateralDeltaRaw: lockedCollateralDelta,
      debtTokenDecimals: borrowToken.decimals,
      collateralTokenDecimals: collateralToken.decimals,
      timestamp,
    })

    const position = await getOrCreateUserMarketPosition(
      context,
      loan.borrower_id,
      facility.market_id,
      collateralToken.decimals,
      timestamp
    )
    const updatedPosition = buildUpdatedUserMarketPosition(position, {
      lockedCollateralDelta,
      totalDebtDelta: debtDelta,
      issuanceTokenDecimals: collateralToken.decimals,
      reserveTokenDecimals: borrowToken.decimals,
      timestamp,
    })
    commitUserMarketPosition(context, updatedPosition)

    recordLoanStatusHistory(context, {
      loanId,
      status: loan.status,
      remainingDebtRaw: newRemainingDebtRaw,
      lockedCollateralRaw: newLockedCollateralRaw,
      borrowTokenDecimals: borrowToken.decimals,
      collateralTokenDecimals: collateralToken.decimals,
      timestamp,
      transactionHash: event.transaction.hash,
      logIndex: event.logIndex,
    })

    context.log.info(
      `[LoanRebalanced] ✅ Loan updated | loanId=${loanId} | locked=${lockedCollateral.formatted} | collDelta=${lockedCollateralDelta} | remainingDebt=${newRemainingDebt.formatted}`
    )
  })
)

CreditFacility.LoanRepaid.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const facilityId = normalizeAddress(event.srcAddress)
    const timestamp = BigInt(event.block.timestamp)
    const facilityContext = await loadFacilityContext(context, facilityId)

    if (!facilityContext) {
      context.log.warn(
        `[LoanRepaid] Facility context missing | facilityId=${facilityId} | block=${event.block.number} | tx=${event.transaction.hash}`
      )
      return
    }

    const { facility, borrowToken, collateralToken } = facilityContext
    const loanId = event.params.loanId_.toString()
    const loan = await context.Loan.get(loanId)

    if (!loan) {
      context.log.warn(
        `[LoanRepaid] Loan not indexed | loanId=${loanId} | facilityId=${facilityId} | tx=${event.transaction.hash}`
      )
      return
    }

    const repaymentAmountRaw = event.params.repaymentAmount_
    const repaymentAmount = formatAmount(repaymentAmountRaw, borrowToken.decimals)

    // Post PR #126: LoanRepaid emits the post-state directly — no local recomputation needed.
    const nextRemainingDebtRaw = event.params.remainingLoanAmount_
    const nextLockedCollateralRaw = event.params.remainingLockedTokens_
    const issuanceTokensUnlockedRaw = event.params.issuanceTokensUnlocked_
    const nextRemainingDebt = formatAmount(nextRemainingDebtRaw, borrowToken.decimals)
    const nextLockedCollateral = formatAmount(nextLockedCollateralRaw, collateralToken.decimals)
    const nextStatus: LoanStatus_t = nextRemainingDebtRaw === 0n ? 'REPAID' : loan.status
    const nextClosedAt = nextStatus === 'REPAID' ? timestamp : loan.closedAt

    const updatedLoan = {
      ...loan,
      remainingDebtRaw: nextRemainingDebtRaw,
      remainingDebtFormatted: nextRemainingDebt.formatted,
      lockedCollateralRaw: nextLockedCollateralRaw,
      lockedCollateralFormatted: nextLockedCollateral.formatted,
      status: nextStatus,
      closedAt: nextClosedAt,
      lastUpdatedAt: timestamp,
    }
    context.Loan.set(updatedLoan)

    const updatedFacility = applyFacilityDeltas({
      facility,
      borrowTokenDecimals: borrowToken.decimals,
      collateralTokenDecimals: collateralToken.decimals,
      timestamp,
      debtDeltaRaw: -repaymentAmountRaw,
      lockedCollateralDeltaRaw: -issuanceTokensUnlockedRaw,
    })
    context.CreditFacilityContract.set(updatedFacility)

    await applyGlobalDebtDelta(context, {
      debtDeltaRaw: -repaymentAmountRaw,
      collateralDeltaRaw: -issuanceTokensUnlockedRaw,
      debtTokenDecimals: borrowToken.decimals,
      collateralTokenDecimals: collateralToken.decimals,
      timestamp,
    })

    const position = await getOrCreateUserMarketPosition(
      context,
      loan.borrower_id,
      facility.market_id,
      collateralToken.decimals,
      timestamp
    )
    const updatedPosition = buildUpdatedUserMarketPosition(position, {
      totalDebtDelta: -repaymentAmountRaw,
      lockedCollateralDelta: -issuanceTokensUnlockedRaw,
      issuanceTokenDecimals: collateralToken.decimals,
      reserveTokenDecimals: borrowToken.decimals,
      timestamp,
    })
    commitUserMarketPosition(context, updatedPosition)

    recordLoanStatusHistory(context, {
      loanId,
      status: nextStatus,
      remainingDebtRaw: nextRemainingDebtRaw,
      lockedCollateralRaw: nextLockedCollateralRaw,
      borrowTokenDecimals: borrowToken.decimals,
      collateralTokenDecimals: collateralToken.decimals,
      timestamp,
      transactionHash: event.transaction.hash,
      logIndex: event.logIndex,
    })

    context.log.info(
      `[LoanRepaid] ✅ Loan updated | loanId=${loanId} | repayment=${repaymentAmount.formatted} | remainingDebt=${nextRemainingDebt.formatted} | unlocked=${issuanceTokensUnlockedRaw}`
    )
  })
)

CreditFacility.LoanClosed.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const facilityId = normalizeAddress(event.srcAddress)
    const timestamp = BigInt(event.block.timestamp)
    const facilityContext = await loadFacilityContext(context, facilityId)

    if (!facilityContext) {
      context.log.warn(
        `[LoanClosed] Facility context missing | facilityId=${facilityId} | block=${event.block.number} | tx=${event.transaction.hash}`
      )
      return
    }

    const { facility, borrowToken, collateralToken } = facilityContext
    const loanId = event.params.loanId_.toString()
    const loan = await context.Loan.get(loanId)

    if (!loan) {
      context.log.warn(
        `[LoanClosed] Loan not indexed | loanId=${loanId} | facilityId=${facilityId} | tx=${event.transaction.hash}`
      )
      return
    }

    const unlockedAmountRaw = loan.lockedCollateralRaw
    const nextLockedCollateralRaw = 0n
    const lockedCollateral = formatAmount(nextLockedCollateralRaw, collateralToken.decimals)

    const updatedLoan = {
      ...loan,
      lockedCollateralRaw: nextLockedCollateralRaw,
      lockedCollateralFormatted: lockedCollateral.formatted,
      remainingDebtRaw: 0n,
      remainingDebtFormatted: formatAmount(0n, borrowToken.decimals).formatted,
      status: 'REPAID' as LoanStatus_t,
      closedAt: timestamp,
      lastUpdatedAt: timestamp,
    }
    context.Loan.set(updatedLoan)

    const updatedFacility = applyFacilityDeltas({
      facility,
      borrowTokenDecimals: borrowToken.decimals,
      collateralTokenDecimals: collateralToken.decimals,
      timestamp,
      lockedCollateralDeltaRaw: -unlockedAmountRaw,
    })
    context.CreditFacilityContract.set(updatedFacility)

    await applyGlobalDebtDelta(context, {
      debtDeltaRaw: -loan.remainingDebtRaw,
      collateralDeltaRaw: -unlockedAmountRaw,
      debtTokenDecimals: borrowToken.decimals,
      collateralTokenDecimals: collateralToken.decimals,
      timestamp,
    })

    const position = await getOrCreateUserMarketPosition(
      context,
      loan.borrower_id,
      facility.market_id,
      collateralToken.decimals,
      timestamp
    )
    const updatedPosition = buildUpdatedUserMarketPosition(position, {
      lockedCollateralDelta: -unlockedAmountRaw,
      issuanceTokenDecimals: collateralToken.decimals,
      reserveTokenDecimals: borrowToken.decimals,
      timestamp,
    })
    commitUserMarketPosition(context, updatedPosition)

    recordLoanStatusHistory(context, {
      loanId,
      status: 'REPAID',
      remainingDebtRaw: 0n,
      lockedCollateralRaw: nextLockedCollateralRaw,
      borrowTokenDecimals: borrowToken.decimals,
      collateralTokenDecimals: collateralToken.decimals,
      timestamp,
      transactionHash: event.transaction.hash,
      logIndex: event.logIndex,
    })

    context.log.info(
      `[LoanClosed] ✅ Loan closed | loanId=${loanId} | borrower=${loan.borrower_id} | unlocked=${
        formatAmount(unlockedAmountRaw, collateralToken.decimals).formatted
      }`
    )
  })
)

CreditFacility.LoanToValueRatioUpdated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const facilityId = normalizeAddress(event.srcAddress)
    const timestamp = BigInt(event.block.timestamp)
    const facility = await context.CreditFacilityContract.get(facilityId)

    if (!facility) {
      context.log.warn(
        `[LoanToValueRatioUpdated] Facility not indexed | facilityId=${facilityId} | tx=${event.transaction.hash}`
      )
      return
    }

    const nextRatio = event.params.newRatio_
    const history = updateFacilityLtvHistory(facility.market_id, nextRatio)

    // Update facility config
    const updatedFacility = {
      ...facility,
      loanToValueRatio: nextRatio,
      lastUpdatedAt: timestamp,
    }
    context.CreditFacilityContract.set(updatedFacility)

    await updateMarketMaxLtv(context, facility.market_id, nextRatio, timestamp)

    context.log.info(
      `[LoanToValueRatioUpdated] ✅ Facility LTV updated | facilityId=${facilityId} | marketId=${facility.market_id} | previous=${history.previousMaxLtv} | next=${history.currentMaxLtv}`
    )
  })
)

// IssuanceTokensLocked/Unlocked were removed from CreditFacility_v1 in contracts PR #126.
// Locked-collateral deltas now flow through LoanCreated (initial lock),
// LoanRebalanced (released collateral delta), and LoanRepaid
// (issuanceTokensUnlocked_ + remainingLockedTokens_).

CreditFacility.LoanTransferred.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const facilityId = normalizeAddress(event.srcAddress)
    const timestamp = BigInt(event.block.timestamp)
    const loanId = event.params.loanId_.toString()
    const loan = await context.Loan.get(loanId)

    if (!loan) {
      context.log.warn(
        `[LoanTransferred] Loan not indexed | loanId=${loanId} | facilityId=${facilityId} | tx=${event.transaction.hash}`
      )
      return
    }

    const facilityContext = await loadFacilityContext(context, facilityId)
    if (!facilityContext) {
      context.log.warn(`[LoanTransferred] Facility context missing | facilityId=${facilityId}`)
      return
    }

    const { facility, borrowToken, collateralToken } = facilityContext
    const oldBorrower = await getOrCreateAccount(context, event.params.previousBorrower_)
    const newBorrower = await getOrCreateAccount(context, event.params.newBorrower_)

    // Decrement old borrower's position
    const oldPosition = await getOrCreateUserMarketPosition(
      context,
      oldBorrower.id,
      facility.market_id,
      collateralToken.decimals,
      timestamp
    )
    const updatedOldPosition = buildUpdatedUserMarketPosition(oldPosition, {
      totalDebtDelta: -loan.remainingDebtRaw,
      lockedCollateralDelta: -loan.lockedCollateralRaw,
      issuanceTokenDecimals: collateralToken.decimals,
      reserveTokenDecimals: borrowToken.decimals,
      timestamp,
    })
    commitUserMarketPosition(context, updatedOldPosition)

    // Increment new borrower's position
    const newPosition = await getOrCreateUserMarketPosition(
      context,
      newBorrower.id,
      facility.market_id,
      collateralToken.decimals,
      timestamp
    )
    const updatedNewPosition = buildUpdatedUserMarketPosition(newPosition, {
      totalDebtDelta: loan.remainingDebtRaw,
      lockedCollateralDelta: loan.lockedCollateralRaw,
      issuanceTokenDecimals: collateralToken.decimals,
      reserveTokenDecimals: borrowToken.decimals,
      timestamp,
    })
    commitUserMarketPosition(context, updatedNewPosition)

    // Update loan ownership
    const updatedLoan = {
      ...loan,
      borrower_id: newBorrower.id,
      lastUpdatedAt: timestamp,
    }
    context.Loan.set(updatedLoan)

    context.log.info(
      `[LoanTransferred] ✅ Loan transferred | loanId=${loanId} | from=${oldBorrower.id} | to=${newBorrower.id} | debt=${loan.remainingDebtRaw} | collateral=${loan.lockedCollateralRaw}`
    )
  })
)

CreditFacility.LoansConsolidated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const facilityId = normalizeAddress(event.srcAddress)
    const timestamp = BigInt(event.block.timestamp)
    const facilityContext = await loadFacilityContext(context, facilityId)

    if (!facilityContext) {
      context.log.warn(
        `[LoansConsolidated] Facility context missing | facilityId=${facilityId} | block=${event.block.number} | tx=${event.transaction.hash}`
      )
      return
    }

    const { facility, borrowToken, collateralToken } = facilityContext
    const borrower = await getOrCreateAccount(context, event.params.borrower_)
    const newLoanId = event.params.newLoanId_.toString()

    // Close old loans
    for (const oldLoanId of event.params.oldLoanIds_) {
      const oldLoan = await context.Loan.get(oldLoanId.toString())
      if (oldLoan) {
        const closedLoan = {
          ...oldLoan,
          status: 'REPAID' as LoanStatus_t,
          closedAt: timestamp,
          lastUpdatedAt: timestamp,
        }
        context.Loan.set(closedLoan)
      }
    }

    // Post PR #126: LoansConsolidated emits both aggregates inline. The ABI calls the
    // loan-amount field `totalCollateralAmount_` but the contract actually passes
    // `totalRemainingLoanAmount` — see CreditFacility_v1.sol:867.
    const lockedCollateralRaw = event.params.totalLockedIssuanceTokens_
    const remainingDebtRaw = event.params.totalCollateralAmount_

    const lockedCollateral = formatAmount(lockedCollateralRaw, collateralToken.decimals)
    const remainingDebt = formatAmount(remainingDebtRaw, borrowToken.decimals)

    // Create new consolidated loan
    const consolidatedLoan = {
      id: newLoanId,
      borrower_id: borrower.id,
      facility_id: facility.id,
      market_id: facility.market_id,
      lockedCollateralRaw,
      lockedCollateralFormatted: lockedCollateral.formatted,
      borrowAmountRaw: remainingDebtRaw,
      borrowAmountFormatted: remainingDebt.formatted,
      originationFeeRaw: 0n,
      originationFeeFormatted: '0',
      remainingDebtRaw,
      remainingDebtFormatted: remainingDebt.formatted,
      floorPriceAtBorrowRaw: 0n,
      floorPriceAtBorrowFormatted: '0',
      status: 'ACTIVE' as LoanStatus_t,
      openedAt: timestamp,
      closedAt: undefined,
      lastUpdatedAt: timestamp,
      transactionHash: event.transaction.hash,
    }
    context.Loan.set(consolidatedLoan)

    context.log.info(
      `[LoansConsolidated] ✅ Loans consolidated | oldLoans=${event.params.oldLoanIds_.length} | newLoanId=${newLoanId} | borrower=${borrower.id} | debt=${remainingDebt.formatted} | collateral=${lockedCollateral.formatted}`
    )
  })
)

CreditFacility.BorrowingFeeRateUpdated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const facilityId = normalizeAddress(event.srcAddress)
    const timestamp = BigInt(event.block.timestamp)
    const facility = await context.CreditFacilityContract.get(facilityId)

    if (!facility) {
      context.log.warn(
        `[BorrowingFeeRateUpdated] Facility not indexed | facilityId=${facilityId} | tx=${event.transaction.hash}`
      )
      return
    }

    const updatedFacility = {
      ...facility,
      borrowingFeeRate: event.params.newFeeRate_,
      lastUpdatedAt: timestamp,
    }
    context.CreditFacilityContract.set(updatedFacility)

    context.log.info(
      `[BorrowingFeeRateUpdated] ✅ Facility borrowing fee updated | facilityId=${facilityId} | newFeeRate=${event.params.newFeeRate_.toString()}`
    )
  })
)

CreditFacility.MaxLoopsUpdated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const facilityId = normalizeAddress(event.srcAddress)
    const timestamp = BigInt(event.block.timestamp)
    const facility = await context.CreditFacilityContract.get(facilityId)

    if (!facility) {
      context.log.warn(
        `[MaxLoopsUpdated] Facility not indexed | facilityId=${facilityId} | tx=${event.transaction.hash}`
      )
      return
    }

    const updatedFacility = {
      ...facility,
      maxLeverage: event.params.newMaxLoops_,
      lastUpdatedAt: timestamp,
    }
    context.CreditFacilityContract.set(updatedFacility)

    context.log.info(
      `[MaxLoopsUpdated] ✅ Facility max loops updated | facilityId=${facilityId} | newMaxLoops=${event.params.newMaxLoops_.toString()}`
    )
  })
)

CreditFacility.LoanToValueRatioLowered.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const facilityId = normalizeAddress(event.srcAddress)
    const timestamp = BigInt(event.block.timestamp)
    const facility = await context.CreditFacilityContract.get(facilityId)

    if (!facility) {
      context.log.warn(
        `[LoanToValueRatioLowered] Facility not indexed | facilityId=${facilityId} | tx=${event.transaction.hash}`
      )
      return
    }

    const updatedFacility = {
      ...facility,
      loanToValueRatio: event.params.newRatio_,
      lastUpdatedAt: timestamp,
    }
    context.CreditFacilityContract.set(updatedFacility)

    await updateMarketMaxLtv(context, facility.market_id, event.params.newRatio_, timestamp)

    context.log.info(
      `[LoanToValueRatioLowered] ✅ LTV lowered | facilityId=${facilityId} | previous=${event.params.previousRatio_.toString()} | new=${event.params.newRatio_.toString()}`
    )
  })
)

CreditFacility.DynamicFeeCalculatorUpdated.handler(
  handlerErrorWrapper(async ({ event, context }) => {
    const facilityId = normalizeAddress(event.srcAddress)
    const timestamp = BigInt(event.block.timestamp)
    const facility = await context.CreditFacilityContract.get(facilityId)

    if (!facility) {
      context.log.warn(
        `[DynamicFeeCalculatorUpdated] Facility not indexed | facilityId=${facilityId} | tx=${event.transaction.hash}`
      )
      return
    }

    const updatedFacility = {
      ...facility,
      lastUpdatedAt: timestamp,
    }
    context.CreditFacilityContract.set(updatedFacility)

    context.log.info(
      `[DynamicFeeCalculatorUpdated] ✅ Fee calculator updated | facilityId=${facilityId} | newCalculator=${event.params.newCalculator_}`
    )
  })
)

type FacilityContext = {
  facility: CreditFacilityContract_t
  borrowToken: Token_t
  collateralToken: Token_t
}

async function loadFacilityContext(
  context: handlerContext,
  facilityId: string
): Promise<FacilityContext | null> {
  const facility = await context.CreditFacilityContract.get(facilityId)
  if (!facility) {
    return null
  }

  const borrowToken = await context.Token.get(facility.borrowToken_id)
  const collateralToken = await context.Token.get(facility.collateralToken_id)

  if (!borrowToken || !collateralToken) {
    return null
  }

  return { facility, borrowToken, collateralToken }
}

function recordLoanStatusHistory(
  context: handlerContext,
  params: {
    loanId: string
    status: LoanStatus_t
    remainingDebtRaw: bigint
    lockedCollateralRaw: bigint
    borrowTokenDecimals: number
    collateralTokenDecimals: number
    timestamp: bigint
    transactionHash: string
    logIndex: number
  }
) {
  const historyId = `${params.loanId}-${params.transactionHash}-${params.logIndex}`
  const entry = {
    id: historyId,
    loan_id: params.loanId,
    status: params.status,
    remainingDebtRaw: params.remainingDebtRaw,
    remainingDebtFormatted: formatAmount(params.remainingDebtRaw, params.borrowTokenDecimals)
      .formatted,
    lockedCollateralRaw: params.lockedCollateralRaw,
    lockedCollateralFormatted: formatAmount(
      params.lockedCollateralRaw,
      params.collateralTokenDecimals
    ).formatted,
    timestamp: params.timestamp,
    transactionHash: params.transactionHash,
  }

  context.LoanStatusHistory.set(entry)
}

function updateFacilityLtvHistory(marketId: string, nextRatio: bigint): FacilityLtvEntry {
  const existing = facilityLtvHistory.get(marketId) ?? {
    previousMaxLtv: 0n,
    currentMaxLtv: 0n,
  }

  const entry: FacilityLtvEntry = {
    previousMaxLtv: existing.currentMaxLtv,
    currentMaxLtv: nextRatio,
  }

  facilityLtvHistory.set(marketId, entry)
  return entry
}

async function updateMarketMaxLtv(
  context: handlerContext,
  marketId: string,
  nextRatio: bigint,
  timestamp: bigint
): Promise<void> {
  const market = await context.Market.get(marketId)
  if (!market) {
    context.log.warn(`[LoanToValueRatioUpdated] Market not found | marketId=${marketId}`)
    return
  }

  context.Market.set({
    ...market,
    maxLTV: nextRatio,
    lastUpdatedAt: timestamp,
  })
}

async function updateMarketFloorPriceViaFacility(
  context: handlerContext,
  marketId: string,
  nextFloorPriceRaw: bigint,
  reserveTokenDecimals: number,
  timestamp: bigint
): Promise<void> {
  const market = (await context.Market.get(marketId)) as Market_t | undefined
  if (!market) {
    context.log.warn(
      `[LoanRebalanced] Market not found while updating floor price | marketId=${marketId}`
    )
    return
  }

  const floorPriceAmount = formatAmount(nextFloorPriceRaw, reserveTokenDecimals)
  const nextInitialFloorPriceRaw =
    market.initialFloorPriceRaw > 0n ? market.initialFloorPriceRaw : nextFloorPriceRaw
  const nextInitialFloorPriceFormatted =
    market.initialFloorPriceRaw > 0n
      ? market.initialFloorPriceFormatted
      : floorPriceAmount.formatted

  context.Market.set({
    ...market,
    floorPriceRaw: nextFloorPriceRaw,
    floorPriceFormatted: floorPriceAmount.formatted,
    initialFloorPriceRaw: nextInitialFloorPriceRaw,
    initialFloorPriceFormatted: nextInitialFloorPriceFormatted,
    lastUpdatedAt: timestamp,
  })
}
