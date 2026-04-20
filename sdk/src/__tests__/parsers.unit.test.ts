import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { stendarIdl } from '../idl';
import {
  CONTRACT_STATUS_MAP,
  DISCRIMINATORS,
  FREQUENCY_MAP,
  INTEREST_PAYMENT_TYPE_MAP,
  LOAN_TYPE_MAP,
  PRINCIPAL_PAYMENT_TYPE_MAP,
  PROPOSAL_STATUS_MAP,
  TRADE_TYPE_MAP,
  VOTE_CHOICE_MAP,
  parseCollateralRegistryAccount,
  parseContractAccount,
  parseContributionAccount,
  parseEscrowAccount,
  parseListingAccount,
  parseOfferAccount,
  parsePoolDepositAccount,
  parseProposalAccount,
  parseProposalVoteAccount,
  parseStateAccount,
  parseTreasuryAccount,
  parseTradeEventAccount,
} from '../parsers';
import { deriveListingPda, deriveOfferPda, deriveTradeEventPda } from '../utils/pda';

const PROGRAM_ID = '278CdXnmeUFSmNjwbmRQmHk87fP5XqGmtshk9Jwp8VdE';
const I64_MAX = 9_223_372_036_854_775_807n;

class BufferWriter {
  private readonly chunks: Buffer[] = [];

  writeBytes(value: Buffer): void {
    this.chunks.push(Buffer.from(value));
  }

  writePubkey(value: string): void {
    this.chunks.push(new PublicKey(value).toBuffer());
  }

  writeU8(value: number): void {
    this.chunks.push(Buffer.from([value & 0xff]));
  }

  writeBool(value: boolean): void {
    this.writeU8(value ? 1 : 0);
  }

  writeU16(value: number): void {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(value);
    this.chunks.push(buf);
  }

  writeU32(value: number): void {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value);
    this.chunks.push(buf);
  }

  writeU64(value: bigint): void {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(value);
    this.chunks.push(buf);
  }

  writeI64(value: bigint): void {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(value);
    this.chunks.push(buf);
  }

  writeOptionU8(value: number | null): void {
    if (value === null) {
      this.writeU8(0);
      return;
    }
    this.writeU8(1);
    this.writeU8(value);
  }

  writePubkeyVec(values: string[]): void {
    this.writeU32(values.length);
    for (const value of values) {
      this.writePubkey(value);
    }
  }

  toBuffer(padToLength?: number): Buffer {
    const out = Buffer.concat(this.chunks);
    if (padToLength === undefined || out.length >= padToLength) {
      return out;
    }
    return Buffer.concat([out, Buffer.alloc(padToLength - out.length)]);
  }
}

function makePubkey(seed: number): string {
  return new PublicKey(Buffer.alloc(32, seed & 0xff)).toBase58();
}

function buildContractCurrentFullBuffer(options?: {
  isRevolving?: boolean;
  availableAmount?: bigint;
}): Buffer {
  const w = new BufferWriter();
  const tailReserved = Buffer.alloc(96, 0xab);
  const isRevolving = options?.isRevolving ?? true;
  const availableAmount = options?.availableAmount ?? 850_000n;

  w.writeBytes(DISCRIMINATORS.DEBT_CONTRACT);
  w.writePubkey(makePubkey(11)); // borrower
  w.writeU64(42n); // contract_seed
  w.writeU8(2); // contract_version
  w.writeU8(1); // loan_type: Committed
  w.writeU64(1_000_000n); // target_amount
  w.writeU32(750); // interest_rate (u32)
  w.writeU32(180); // term_days
  w.writeU32(12_000); // ltv_ratio
  w.writeU32(11_000); // ltv_floor_bps
  w.writeU8(0); // interest_payment_type: OutstandingBalance
  w.writeU8(1); // principal_payment_type: NoFixedPayment
  w.writeU8(3); // interest_frequency: Monthly
  w.writeOptionU8(2); // principal_frequency: BiWeekly
  w.writeU64(5_000_000_000n); // collateral_amount
  w.writePubkey(makePubkey(41)); // collateral_mint
  w.writePubkey(makePubkey(42)); // collateral_token_account
  w.writeU64(2_100_000n); // collateral_value_at_creation
  w.writePubkey(makePubkey(43)); // loan_mint
  w.writePubkey(makePubkey(44)); // loan_token_account
  w.writeU64(800_000n); // funded_amount
  w.writeU16(14); // max_lenders
  w.writeU8(1); // partial_funding_flag
  w.writeU8(1); // funding_access_mode: AllowlistOnly
  w.writeBool(true); // allow_partial_fill
  w.writeU16(5_000); // min_partial_fill_bps
  w.writeU8(2); // status: Active
  w.writeI64(1_700_000_000n); // created_at
  w.writeI64(1_800_000_000n); // expires_at
  w.writeU64(1_000n); // listing_fee_paid
  w.writeU64(790_000n); // outstanding_balance
  w.writeU64(10_000n); // accrued_interest
  w.writeU64(50_000n); // total_principal_paid
  w.writeU64(654n); // total_prepayment_fees
  w.writeU64(321n); // uncollectable_balance
  w.writeI64(1_700_010_000n); // last_interest_update
  w.writeI64(1_700_020_000n); // last_principal_payment
  w.writeI64(1_700_030_000n); // last_bot_update
  w.writeI64(1_700_090_000n); // next_interest_payment_due
  w.writeI64(1_700_090_000n); // next_principal_payment_due
  w.writeU64(5n); // bot_operation_count
  w.writeU32(2); // num_contributions
  w.writePubkeyVec([makePubkey(31), makePubkey(32)]); // contributions vec
  w.writeBool(true); // recall_requested
  w.writeI64(1_700_100_000n); // recall_requested_at
  w.writePubkey(makePubkey(45)); // recall_requested_by
  w.writeBool(isRevolving); // is_revolving
  w.writeU64(1_200_000n); // credit_limit
  w.writeU64(350_000n); // drawn_amount
  w.writeU64(availableAmount); // available_amount
  w.writeU32(225); // standby_fee_rate
  w.writeU64(4_200n); // accrued_standby_fees
  w.writeI64(1_700_100_500n); // last_standby_fee_update
  w.writeU32(3); // total_draws
  w.writeU64(9_999n); // total_standby_fees_paid
  w.writeBool(false); // revolving_closed
  w.writeBool(true); // has_active_proposal
  w.writeU64(7n); // proposal_count
  w.writePubkey(makePubkey(46)); // frontend
  w.writeBytes(tailReserved);
  w.writeU16(1); // account_version

  return w.toBuffer(1045);
}

function buildContributionBuffer(): Buffer {
  const w = new BufferWriter();
  w.writeBytes(DISCRIMINATORS.LENDER_CONTRIBUTION);
  w.writePubkey(makePubkey(71));
  w.writePubkey(makePubkey(72));
  w.writeU64(750_000n);
  w.writeU64(12_345n);
  w.writeU64(6_789n);
  w.writeI64(1_700_200_000n);
  w.writeBool(false);
  w.writeI64(1_700_000_000n);
  w.writeI64(1_700_100_000n);
  w.writeBytes(Buffer.alloc(96));
  w.writeU16(1);
  return w.toBuffer(219);
}

function buildEscrowBuffer(): Buffer {
  const w = new BufferWriter();
  w.writeBytes(DISCRIMINATORS.LENDER_ESCROW);
  w.writePubkey(makePubkey(81));
  w.writePubkey(makePubkey(82));
  w.writeU64(100_000n);
  w.writeU64(1_000n);
  w.writeU64(2_000n);
  w.writeU64(300n);
  w.writeBool(false);
  w.writeI64(1_700_300_000n);
  w.writePubkey(makePubkey(83));
  w.writeBytes(Buffer.alloc(96));
  w.writeU16(1);
  return w.toBuffer(243);
}

function buildCollateralRegistryBuffer(): Buffer {
  const w = new BufferWriter();
  w.writeBytes(DISCRIMINATORS.COLLATERAL_REGISTRY);
  w.writePubkey(makePubkey(91));
  w.writeU8(2);
  w.writeU32(2);

  w.writePubkey(makePubkey(92));
  w.writePubkey(makePubkey(93));
  w.writeU8(8);
  w.writeU16(500);
  w.writeU16(10_500);
  w.writeBool(true);

  w.writePubkey(makePubkey(94));
  w.writePubkey(makePubkey(95));
  w.writeU8(9);
  w.writeU16(800);
  w.writeU16(11_000);
  w.writeBool(false);
  w.writeBytes(Buffer.alloc(96));
  w.writeU16(1);

  return w.toBuffer();
}

function buildProposalBuffer(): Buffer {
  const w = new BufferWriter();
  w.writeBytes(DISCRIMINATORS.TERM_AMENDMENT_PROPOSAL);
  w.writePubkey(makePubkey(101));
  w.writePubkey(makePubkey(102));
  w.writeU64(55n);
  w.writeU32(900);
  w.writeU32(365);
  w.writeU8(3); // Monthly
  w.writeOptionU8(1); // Weekly
  w.writeU8(0); // OutstandingBalance
  w.writeU8(1); // NoFixedPayment
  w.writeU32(12_000);
  w.writeU32(10_800);
  w.writePubkeyVec([makePubkey(103), makePubkey(104)]);
  w.writeU8(2); // total participants
  w.writeU8(1); // approvals
  w.writeU8(0); // rejections
  w.writeU8(0); // Pending
  w.writeI64(1_700_400_000n);
  w.writeI64(1_700_500_000n);
  w.writeI64(0n);
  w.writeU32(2); // recall_pledged_count
  w.writeU64(150_000n); // recall_pledged_amount
  w.writeU32(1); // recalls_processed
  w.writeI64(1_700_410_000n); // recall_grace_start
  w.writeBytes(Buffer.alloc(96));
  w.writeU16(1);
  return w.toBuffer();
}

function buildProposalVoteBuffer(): Buffer {
  const w = new BufferWriter();
  w.writeBytes(DISCRIMINATORS.PROPOSAL_VOTE);
  w.writePubkey(makePubkey(111));
  w.writePubkey(makePubkey(112));
  w.writeU8(1); // Reject
  w.writeI64(1_700_410_000n);
  w.writeBool(true); // recall_on_rejection
  w.writeBytes(Buffer.alloc(96));
  w.writeU16(1);
  return w.toBuffer();
}

function buildListingBuffer(): Buffer {
  const w = new BufferWriter();
  w.writeBytes(DISCRIMINATORS.TRADE_LISTING);
  w.writePubkey(makePubkey(121));
  w.writePubkey(makePubkey(122));
  w.writePubkey(makePubkey(123));
  w.writeU64(250_000n);
  w.writeU64(260_000n);
  w.writeU8(0); // FullPosition
  w.writeI64(1_700_500_000n);
  w.writeI64(1_700_800_000n);
  w.writeBool(true);
  w.writeU32(4);
  w.writeU64(255_000n);
  w.writeU8(9);
  w.writeBytes(Buffer.alloc(96));
  w.writeU16(1);
  return w.toBuffer();
}

function buildOfferBuffer(): Buffer {
  const w = new BufferWriter();
  w.writeBytes(DISCRIMINATORS.TRADE_OFFER);
  w.writePubkey(makePubkey(131));
  w.writePubkey(makePubkey(132));
  w.writeU64(125_000n);
  w.writeU64(130_000n);
  w.writeI64(1_700_510_000n);
  w.writeI64(I64_MAX); // max timestamp edge case
  w.writeBool(false);
  w.writeU8(7);
  w.writeBytes(Buffer.alloc(96));
  w.writeU16(1);
  return w.toBuffer();
}

function buildTradeEventBuffer(): Buffer {
  const w = new BufferWriter();
  w.writeBytes(DISCRIMINATORS.TRADE_EVENT);
  w.writePubkey(makePubkey(141));
  w.writePubkey(makePubkey(142));
  w.writePubkey(makePubkey(143));
  w.writePubkey(makePubkey(144));
  w.writeU64(200_000n);
  w.writeU64(210_000n);
  w.writeU64(100n);
  w.writeU64(50n);
  w.writeU8(2); // PartialFill
  w.writeI64(1_700_520_000n);
  w.writeU8(3);
  w.writeBytes(Buffer.alloc(96));
  w.writeU16(1);
  return w.toBuffer();
}

function buildStateBuffer(): Buffer {
  const w = new BufferWriter();
  w.writeBytes(DISCRIMINATORS.STATE);
  w.writePubkey(makePubkey(151));
  w.writeU64(2_000_000n); // total_debt
  w.writeU64(3_000_000n); // total_collateral
  w.writeU64(45_000n); // total_interest_paid
  w.writeU64(12n); // total_liquidations
  w.writeU64(5n); // total_partial_liquidations
  w.writeU64(42n); // total_contracts
  w.writeU16(10); // platform_fee_basis_points
  w.writeU16(15); // pool_deposit_fee_bps
  w.writeU16(20); // pool_yield_fee_bps
  w.writeU16(25); // primary_listing_fee_bps
  w.writeU16(30); // secondary_listing_fee_bps
  w.writeU16(35); // secondary_buyer_fee_bps
  w.writeBool(false); // is_paused
  w.writeBytes(Buffer.alloc(96));
  w.writeU16(1); // account_version
  return w.toBuffer(199);
}

function buildTreasuryBuffer(): Buffer {
  const w = new BufferWriter();
  w.writeBytes(DISCRIMINATORS.TREASURY);
  w.writePubkey(makePubkey(161)); // authority
  w.writePubkey(makePubkey(162)); // pending_authority
  w.writePubkey(makePubkey(163)); // bot_authority
  w.writeU64(900_000n); // fees_collected
  w.writeU64(100_000n); // transaction_costs
  w.writeU64(55n); // automated_operations
  w.writeU64(40n); // total_contracts_processed
  w.writeI64(1_700_600_000n); // last_update
  w.writeI64(1_700_000_000n); // created_at
  w.writePubkey(makePubkey(164)); // usdc_mint
  w.writePubkey(makePubkey(165)); // treasury_usdc_account
  w.writeU64(10_000n); // total_liquidation_fees
  w.writeU64(5_000n); // total_recall_fees
  w.writeBytes(Buffer.alloc(96));
  w.writeU16(1); // account_version
  return w.toBuffer(330);
}

function buildPoolDepositBuffer(): Buffer {
  const w = new BufferWriter();
  w.writeBytes(DISCRIMINATORS.POOL_DEPOSIT);
  w.writePubkey(makePubkey(171)); // depositor
  w.writePubkey(makePubkey(172)); // pool
  w.writeU64(1_000_000n); // deposit_amount
  w.writeU64(25_000n); // accrued_yield
  w.writeI64(1_700_700_000n); // last_yield_update
  w.writeI64(1_700_600_000n); // deposit_timestamp
  w.writeBool(true); // withdrawal_requested
  w.writeI64(1_700_710_000n); // withdrawal_requested_at
  w.writeU64(100_000n); // withdrawal_requested_amount
  w.writeU64(5_000n); // total_yield_claimed
  w.writePubkey(makePubkey(173)); // frontend
  w.writeU8(1); // yield_preference
  w.writeU64(42_000n); // total_yield_compounded
  w.writeBytes(Buffer.alloc(96));
  w.writeU16(1); // account_version
  return w.toBuffer(268);
}

test('DISCRIMINATORS are 8-byte buffers synchronized with IDL accounts', () => {
  for (const [key, value] of Object.entries(DISCRIMINATORS)) {
    assert.equal(value.length, 8, `${key} should be 8 bytes`);
  }

  const idlAccounts = (stendarIdl as unknown as { accounts?: Array<{ name: string; discriminator: number[] }> }).accounts;
  assert.ok(Array.isArray(idlAccounts));

  const idlDebtContract = idlAccounts?.find((account) => account.name === 'DebtContract');
  assert.ok(idlDebtContract);
  assert.ok(DISCRIMINATORS.DEBT_CONTRACT.equals(Buffer.from(idlDebtContract!.discriminator)));
});

test('enum maps include all expected variants', () => {
  assert.deepEqual(CONTRACT_STATUS_MAP, {
    0: 'OpenNotFunded',
    1: 'OpenPartiallyFunded',
    2: 'Active',
    3: 'PendingRecall',
    4: 'Completed',
    5: 'Cancelled',
    6: 'Liquidated',
  });
  assert.deepEqual(LOAN_TYPE_MAP, { 0: 'Demand', 1: 'Committed' });
  assert.deepEqual(FREQUENCY_MAP, { 0: 'Daily', 1: 'Weekly', 2: 'BiWeekly', 3: 'Monthly' });
  assert.deepEqual(INTEREST_PAYMENT_TYPE_MAP, { 0: 'OutstandingBalance', 1: 'CollateralTransfer' });
  assert.deepEqual(PRINCIPAL_PAYMENT_TYPE_MAP, { 0: 'CollateralDeduction', 1: 'NoFixedPayment' });
  assert.deepEqual(PROPOSAL_STATUS_MAP, { 0: 'Pending', 1: 'Approved', 2: 'Rejected', 3: 'Expired', 4: 'Cancelled' });
  assert.deepEqual(VOTE_CHOICE_MAP, { 0: 'Approve', 1: 'Reject' });
  assert.deepEqual(TRADE_TYPE_MAP, { 0: 'DirectSale', 1: 'AcceptedOffer', 2: 'PartialFill' });
});

test('parseContractAccount handles current layout', () => {
  const contract = parseContractAccount(buildContractCurrentFullBuffer());
  assert.ok(contract);
  assert.equal(contract?.layout, 'current');
  assert.equal(contract?.status, 'Active');
  assert.equal(contract?.loanType, 'Committed');
  assert.equal(contract?.fundingAccessMode, 'AllowlistOnly');
  assert.equal(contract?.hasActiveProposal, true);
  assert.equal(contract?.proposalCount, '7');
  assert.equal(contract?.uncollectableBalanceRaw, '321');
  assert.equal(contract?.totalPrepaymentFeesRaw, '654');
  assert.equal(contract?.contractVersion, 2);
  assert.equal(contract?.accountVersion, 1);
  assert.equal(contract?.isRevolving, true);
  assert.equal(contract?.standbyFeeRate, 225);
  assert.equal(contract?.drawnAmountRaw, '350000');
  assert.equal(contract?.availableAmountRaw, '850000');
  assert.equal(contract?.effectiveDrawableRaw, '850000');
  assert.equal(contract?.accruedStandbyFeesRaw, '4200');
  assert.equal(contract?.revolvingClosed, false);
  assert.equal(contract?.frontend, makePubkey(46));
});

test('parseContractAccount sets effective drawable to zero for non-revolving layouts', () => {
  const contract = parseContractAccount(
    buildContractCurrentFullBuffer({
      isRevolving: false,
      availableAmount: 850_000n,
    }),
  );
  assert.ok(contract);
  assert.equal(contract?.isRevolving, false);
  assert.equal(contract?.availableAmountRaw, '850000');
  assert.equal(contract?.effectiveDrawableRaw, '0');
});

test('parseContributionAccount handles current layout', () => {
  const current = parseContributionAccount(buildContributionBuffer());
  assert.ok(current);
  assert.equal(current?.layout, 'current_219');
  assert.equal(current?.accountVersion, 1);
});

test('parseEscrowAccount parses numeric and status fields', () => {
  const parsed = parseEscrowAccount(buildEscrowBuffer());
  assert.ok(parsed);
  assert.equal(parsed?.isReleased, false);
  assert.equal(parsed?.accountVersion, 1);
  assert.equal(parsed?.availableInterestRaw, '1000');
});

test('parseCollateralRegistryAccount parses collateral vector entries', () => {
  const parsed = parseCollateralRegistryAccount(buildCollateralRegistryBuffer());
  assert.ok(parsed);
  assert.equal(parsed?.numCollateralTypes, 2);
  assert.equal(parsed?.collateralTypes.length, 2);
  assert.equal(parsed?.collateralTypes[0]?.decimals, 8);
  assert.equal(parsed?.collateralTypes[1]?.isActive, false);
  assert.equal(parsed?.accountVersion, 1);
});

test('state, treasury, and pool deposit parsers decode promoted layouts', () => {
  const state = parseStateAccount(buildStateBuffer());
  assert.ok(state);
  assert.equal(state?.accountVersion, 1);
  assert.equal(state?.isPaused, false);
  assert.equal(state?.totalContracts, '42');
  assert.equal(state?.totalDebtRaw, '2000000');

  const treasury = parseTreasuryAccount(buildTreasuryBuffer());
  assert.ok(treasury);
  assert.equal(treasury?.accountVersion, 1);
  assert.equal(treasury?.authority, makePubkey(161));
  assert.equal(treasury?.feesCollectedRaw, '900000');
  assert.equal(treasury?.totalContractsProcessed, '40');

  const poolDeposit = parsePoolDepositAccount(buildPoolDepositBuffer());
  assert.ok(poolDeposit);
  assert.equal(poolDeposit?.accountVersion, 1);
  assert.equal(poolDeposit?.yieldPreference, 1);
  assert.equal(poolDeposit?.withdrawalRequested, true);
  assert.equal(poolDeposit?.totalYieldCompoundedRaw, '42000');
});

test('proposal and proposal vote parsers decode enum and timestamp fields', () => {
  const proposal = parseProposalAccount(buildProposalBuffer());
  assert.ok(proposal);
  assert.equal(proposal?.status, 'Pending');
  assert.equal(proposal?.proposedInterestFrequency, 'Monthly');
  assert.equal(proposal?.proposedPrincipalFrequency, 'Weekly');
  assert.equal(proposal?.participantKeys.length, 2);
  assert.equal(proposal?.recallPledgedCount, 2);
  assert.equal(proposal?.recallPledgedAmountRaw, '150000');
  assert.equal(proposal?.recallsProcessed, 1);

  const vote = parseProposalVoteAccount(buildProposalVoteBuffer());
  assert.ok(vote);
  assert.equal(vote?.voteChoice, 'Reject');
  assert.equal(vote?.recallOnRejection, true);
  assert.equal(vote?.accountVersion, 1);
});

test('listing, offer, and trade event parsers decode trading accounts', () => {
  const listing = parseListingAccount(buildListingBuffer());
  assert.ok(listing);
  assert.equal(listing?.listingType, 'FullPosition');
  assert.equal(listing?.offerCount, 4);
  assert.equal(listing?.accountVersion, 1);

  const offer = parseOfferAccount(buildOfferBuffer());
  assert.ok(offer);
  assert.equal(offer?.nonce, 7);
  assert.equal(offer?.expiresAt, I64_MAX.toString());
  assert.equal(offer?.accountVersion, 1);

  const event = parseTradeEventAccount(buildTradeEventBuffer());
  assert.ok(event);
  assert.equal(event?.tradeType, 'PartialFill');
  assert.equal(event?.platformFeeRaw, '100');
  assert.equal(event?.buyerFeeRaw, '50');
  assert.equal(event?.accountVersion, 1);
});

test('all parser functions return null for invalid or corrupted buffers', () => {
  const wrongDiscriminator = Buffer.concat([Buffer.alloc(8, 0xaa), Buffer.alloc(64)]);
  assert.equal(parseContractAccount(wrongDiscriminator), null);
  assert.equal(parseContributionAccount(wrongDiscriminator), null);
  assert.equal(parseEscrowAccount(wrongDiscriminator), null);
  assert.equal(parseCollateralRegistryAccount(wrongDiscriminator), null);
  assert.equal(parseProposalAccount(wrongDiscriminator), null);
  assert.equal(parseProposalVoteAccount(wrongDiscriminator), null);
  assert.equal(parseListingAccount(wrongDiscriminator), null);
  assert.equal(parseOfferAccount(wrongDiscriminator), null);
  assert.equal(parseTradeEventAccount(wrongDiscriminator), null);
  assert.equal(parseStateAccount(wrongDiscriminator), null);
  assert.equal(parseTreasuryAccount(wrongDiscriminator), null);
  assert.equal(parsePoolDepositAccount(wrongDiscriminator), null);

  assert.equal(parseContractAccount(Buffer.from(DISCRIMINATORS.DEBT_CONTRACT)), null);
  assert.equal(parseContributionAccount(Buffer.from(DISCRIMINATORS.LENDER_CONTRIBUTION)), null);
});

test('trading PDA derivation helpers match on-chain seed formulas', () => {
  const programKey = new PublicKey(PROGRAM_ID);
  const contribution = new PublicKey(makePubkey(201));
  const listing = new PublicKey(makePubkey(202));
  const buyer = new PublicKey(makePubkey(203));
  const seller = new PublicKey(makePubkey(204));
  const listingNonce = 9;
  const offerNonce = 7;
  const tradeNonce = 3;

  const [derivedListing, derivedListingBump] = deriveListingPda(
    contribution.toBase58(),
    seller.toBase58(),
    listingNonce,
    PROGRAM_ID
  );
  const [expectedListing, expectedListingBump] = PublicKey.findProgramAddressSync(
    [Buffer.from('listing'), contribution.toBuffer(), Buffer.from([listingNonce])],
    programKey
  );
  assert.equal(derivedListing.toBase58(), expectedListing.toBase58());
  assert.equal(derivedListingBump, expectedListingBump);

  const [derivedOffer, derivedOfferBump] = deriveOfferPda(
    listing.toBase58(),
    buyer.toBase58(),
    offerNonce,
    PROGRAM_ID
  );
  const [expectedOffer, expectedOfferBump] = PublicKey.findProgramAddressSync(
    [Buffer.from('offer'), listing.toBuffer(), buyer.toBuffer(), Buffer.from([offerNonce])],
    programKey
  );
  assert.equal(derivedOffer.toBase58(), expectedOffer.toBase58());
  assert.equal(derivedOfferBump, expectedOfferBump);

  const [derivedTradeEvent, derivedTradeEventBump] = deriveTradeEventPda(listing.toBase58(), tradeNonce, PROGRAM_ID);
  const [expectedTradeEvent, expectedTradeEventBump] = PublicKey.findProgramAddressSync(
    [Buffer.from('trade'), listing.toBuffer(), Buffer.from([tradeNonce])],
    programKey
  );
  assert.equal(derivedTradeEvent.toBase58(), expectedTradeEvent.toBase58());
  assert.equal(derivedTradeEventBump, expectedTradeEventBump);
});
