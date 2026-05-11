import { assert } from "chai";
import fs from "fs";
import path from "path";

describe("Security regression static guards", () => {
  const lendingContextsPath = path.join(process.cwd(), "programs/stendar/src/contexts/lending.rs");
  const adminContextsPath = path.join(process.cwd(), "programs/stendar/src/contexts/admin.rs");
  const revolvingContextsPath = path.join(
    process.cwd(),
    "programs/stendar/src/contexts/revolving.rs",
  );
  const lendingInstructionsPath = path.join(process.cwd(), "programs/stendar/src/instructions/lending.rs");
  const paymentContextsPath = path.join(process.cwd(), "programs/stendar/src/contexts/payment.rs");
  const revolvingInstructionsPath = path.join(
    process.cwd(),
    "programs/stendar/src/instructions/revolving.rs",
  );
  const poolsInstructionsPath = path.join(process.cwd(), "programs/stendar/src/instructions/pools.rs");
  const proposalsInstructionsPath = path.join(process.cwd(), "programs/stendar/src/instructions/proposals.rs");
  const adminInstructionsPath = path.join(process.cwd(), "programs/stendar/src/instructions/admin_operations.rs");
  const paymentInstructionsPath = path.join(
    process.cwd(),
    "programs/stendar/src/instructions/payment_operations.rs",
  );
  const programLibPath = path.join(process.cwd(), "programs/stendar/src/lib.rs");
  const interestUtilsPath = path.join(process.cwd(), "programs/stendar/src/utils/interest.rs");
  const cargoTomlPath = path.join(process.cwd(), "programs/stendar/Cargo.toml");
  const oracleUtilsPath = path.join(process.cwd(), "programs/stendar/src/utils/oracle.rs");
  const proposalsContextsPath = path.join(process.cwd(), "programs/stendar/src/contexts/proposals.rs");
  const poolsContextsPath = path.join(process.cwd(), "programs/stendar/src/contexts/pools.rs");
  const tradingContextsPath = path.join(process.cwd(), "programs/stendar/src/contexts/trading.rs");
  const tradingStatePath = path.join(process.cwd(), "programs/stendar/src/state/trading.rs");
  const poolsStatePath = path.join(process.cwd(), "programs/stendar/src/state/pools.rs");
  const proposalsStatePath = path.join(process.cwd(), "programs/stendar/src/state/proposals.rs");
  const errorsPath = path.join(process.cwd(), "programs/stendar/src/errors.rs");
  const tradingInstructionsPath = path.join(
    process.cwd(),
    "programs/stendar/src/instructions/trading.rs",
  );
  const tradingUtilsPath = path.join(process.cwd(), "programs/stendar/src/utils/trading.rs");
  const collateralContextsPath = path.join(process.cwd(), "programs/stendar/src/contexts/collateral.rs");
  const sdkIdlPath = path.join(process.cwd(), "sdk/src/idl/stendar.json");
  const sdkFeesPath = path.join(process.cwd(), "sdk/src/utils/fees.ts");
  const sdkPdaPath = path.join(process.cwd(), "sdk/src/utils/pda.ts");
  const stateModPath = path.join(process.cwd(), "programs/stendar/src/state/mod.rs");

  function extractRustFunctionBody(source: string, functionName: string): string {
    const signature = `pub fn ${functionName}`;
    const signatureIndex = source.indexOf(signature);
    assert.isAtLeast(signatureIndex, 0, `${functionName} function definition not found`);

    const bodyStart = source.indexOf("{", signatureIndex);
    assert.isAtLeast(bodyStart, 0, `${functionName} function body start not found`);

    let braceDepth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") {
        braceDepth += 1;
      } else if (char === "}") {
        braceDepth -= 1;
        if (braceDepth === 0) {
          return source.slice(bodyStart + 1, index);
        }
      }
    }

    throw new Error(`${functionName} function body end not found`);
  }

  function extractRustSeedConstant(source: string, constantName: string): string {
    const match = source.match(
      new RegExp(`pub const ${constantName}: &\\[u8\\] = b"([^"]+)";`),
    );
    assert.isNotNull(match, `${constantName} seed constant not found`);
    return match![1];
  }

  function extractTypeScriptFunctionBody(source: string, functionName: string): string {
    const signature = `export function ${functionName}`;
    const signatureIndex = source.indexOf(signature);
    assert.isAtLeast(signatureIndex, 0, `${functionName} function definition not found`);

    const bodyStart = source.indexOf("{", signatureIndex);
    assert.isAtLeast(bodyStart, 0, `${functionName} function body start not found`);

    let braceDepth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") {
        braceDepth += 1;
      } else if (char === "}") {
        braceDepth -= 1;
        if (braceDepth === 0) {
          return source.slice(bodyStart + 1, index);
        }
      }
    }

    throw new Error(`${functionName} function body end not found`);
  }

  it("preserves existing Anchor error codes when adding P0 errors", () => {
    const idl = JSON.parse(fs.readFileSync(sdkIdlPath, "utf8")) as {
      errors: Array<{ code: number; name: string }>;
    };
    const errorCodes = new Map(idl.errors.map((entry) => [entry.name, entry.code]));

    assert.equal(errorCodes.get("WithdrawalCooldownNotElapsed"), 6117);
    assert.equal(errorCodes.get("PoolHasPendingWithdrawals"), 6130);
    assert.equal(errorCodes.get("ContractNotEligibleForLiquidation"), 6145);
    assert.equal(errorCodes.get("ProposalRecallsPending"), 6146);
    assert.equal(errorCodes.get("PoolWithdrawalQueueDisabled"), 6147);
  });

  it("keeps SDK recall constants aligned with on-chain values", () => {
    const sdkSource = fs.readFileSync(sdkFeesPath, "utf8");
    const stateSource = fs.readFileSync(stateModPath, "utf8");

    const stateGraceMatch = stateSource.match(/pub const RECALL_GRACE_PERIOD_SECONDS: i64 = ([\d_]+)/);
    const sdkGraceMatch = sdkSource.match(/export const RECALL_GRACE_PERIOD_SECONDS = ([\d_]+)/);
    const stateFeeMatch = stateSource.match(/pub const RECALL_FEE_BPS: u16 = ([\d_]+)/);
    const sdkFeeMatch = sdkSource.match(/export const RECALL_FEE_BPS = ([\d_]+)/);

    assert.isNotNull(
      stateGraceMatch,
      "on-chain RECALL_GRACE_PERIOD_SECONDS constant is missing from state/mod.rs",
    );
    assert.isNotNull(
      sdkGraceMatch,
      "SDK RECALL_GRACE_PERIOD_SECONDS constant is missing from sdk/src/utils/fees.ts",
    );
    assert.isNotNull(stateFeeMatch, "on-chain RECALL_FEE_BPS constant is missing from state/mod.rs");
    assert.isNotNull(sdkFeeMatch, "SDK RECALL_FEE_BPS constant is missing from sdk/src/utils/fees.ts");

    const parseNumericConstant = (value: string): number => Number.parseInt(value.replace(/_/g, ""), 10);

    assert.equal(
      parseNumericConstant(sdkGraceMatch![1]),
      parseNumericConstant(stateGraceMatch![1]),
      "SDK RECALL_GRACE_PERIOD_SECONDS must match on-chain RECALL_GRACE_PERIOD_SECONDS",
    );
    assert.equal(
      parseNumericConstant(sdkFeeMatch![1]),
      parseNumericConstant(stateFeeMatch![1]),
      "SDK RECALL_FEE_BPS must match on-chain RECALL_FEE_BPS",
    );
  });

  it("keeps phase-2A PDA seed literals centralized and SDK-aligned", () => {
    const stateSource = fs.readFileSync(stateModPath, "utf8");
    const tradingStateSource = fs.readFileSync(tradingStatePath, "utf8");
    const proposalsStateSource = fs.readFileSync(proposalsStatePath, "utf8");
    const tradingContextsSource = fs.readFileSync(tradingContextsPath, "utf8");
    const proposalsContextsSource = fs.readFileSync(proposalsContextsPath, "utf8");
    const poolsContextsSource = fs.readFileSync(poolsContextsPath, "utf8");
    const sdkPdaSource = fs.readFileSync(sdkPdaPath, "utf8");

    const sdkSeedChecks: Array<[string, string]> = [
      [extractRustSeedConstant(stateSource, "GLOBAL_STATE_SEED"), "deriveGlobalStatePda"],
      [extractRustSeedConstant(stateSource, "TREASURY_SEED"), "deriveTreasuryPda"],
      [extractRustSeedConstant(stateSource, "COLLATERAL_REGISTRY_SEED"), "deriveCollateralRegistryPda"],
      [extractRustSeedConstant(stateSource, "POOL_SEED"), "derivePoolPda"],
      [extractRustSeedConstant(stateSource, "POOL_OPERATOR_SEED"), "derivePoolOperatorPda"],
      [extractRustSeedConstant(stateSource, "PENDING_POOL_CHANGE_SEED"), "derivePendingPoolChangePda"],
      [extractRustSeedConstant(stateSource, "DEBT_CONTRACT_SEED"), "deriveContractPda"],
      [extractRustSeedConstant(stateSource, "OPERATIONS_FUND_SEED"), "deriveOperationsFundPda"],
      [extractRustSeedConstant(stateSource, "CONTRIBUTION_SEED"), "deriveContributionPda"],
      [extractRustSeedConstant(stateSource, "ESCROW_SEED"), "deriveEscrowPda"],
      [extractRustSeedConstant(stateSource, "POOL_DEPOSIT_SEED"), "derivePoolDepositPda"],
      [extractRustSeedConstant(stateSource, "APPROVED_FUNDER_SEED"), "deriveApprovedFunderPda"],
      [extractRustSeedConstant(proposalsStateSource, "TERM_PROPOSAL_SEED"), "deriveTermProposalPda"],
      [extractRustSeedConstant(proposalsStateSource, "PROPOSAL_VOTE_SEED"), "deriveProposalVotePda"],
      [extractRustSeedConstant(proposalsStateSource, "PROPOSER_COOLDOWN_SEED"), "deriveProposerCooldownPda"],
      [extractRustSeedConstant(tradingStateSource, "TRADE_LISTING_SEED"), "deriveListingPda"],
      [extractRustSeedConstant(tradingStateSource, "TRADE_OFFER_SEED"), "deriveOfferPda"],
      [extractRustSeedConstant(tradingStateSource, "TRADE_EVENT_SEED"), "deriveTradeEventPda"],
      [extractRustSeedConstant(tradingStateSource, "TRADE_TRANSFER_EVENT_SEED"), "deriveTransferEventPda"],
    ];

    for (const [seedLiteral, helperName] of sdkSeedChecks) {
      const helperBody = extractTypeScriptFunctionBody(sdkPdaSource, helperName);
      assert.include(
        helperBody,
        `Buffer.from('${seedLiteral}')`,
        `SDK PDA helper ${helperName} should use on-chain seed literal '${seedLiteral}'`,
      );
    }

    for (const requiredConstant of [
      "GLOBAL_STATE_SEED",
      "CONTRIBUTION_SEED",
      "ESCROW_SEED",
      "DEBT_CONTRACT_SEED",
      "TRADE_LISTING_SEED",
      "TRADE_OFFER_SEED",
      "TRADE_EVENT_SEED",
      "TRADE_TRANSFER_EVENT_SEED",
    ]) {
      assert.include(
        tradingContextsSource,
        requiredConstant,
        `trading contexts should reference centralized ${requiredConstant}`,
      );
    }
    for (const disallowedLiteral of [
      'b"global_state"',
      'b"debt_contract"',
      'b"contribution"',
      'b"escrow"',
      'b"listing"',
      'b"offer"',
      'b"trade"',
      'b"transfer"',
    ]) {
      assert.notInclude(
        tradingContextsSource,
        disallowedLiteral,
        `trading contexts should avoid direct literal ${disallowedLiteral}`,
      );
    }

    assert.include(
      proposalsContextsSource,
      "GLOBAL_STATE_SEED",
      "proposal contexts should reference centralized GLOBAL_STATE_SEED",
    );
    assert.notInclude(
      proposalsContextsSource,
      'b"global_state"',
      "proposal contexts should avoid direct global_state literal",
    );

    for (const requiredConstant of ["GLOBAL_STATE_SEED", "CONTRIBUTION_SEED", "ESCROW_SEED"]) {
      assert.include(
        poolsContextsSource,
        requiredConstant,
        `pool contexts should reference centralized ${requiredConstant}`,
      );
    }
    for (const disallowedLiteral of ['b"global_state"', 'b"contribution"', 'b"escrow"']) {
      assert.notInclude(
        poolsContextsSource,
        disallowedLiteral,
        `pool contexts should avoid direct literal ${disallowedLiteral}`,
      );
    }
  });

  it("keeps phase-2A account layouts reserved and versioned", () => {
    const stateSources: Array<[string, string[], string]> = [
      [
        fs.readFileSync(tradingStatePath, "utf8"),
        ["TradeListing", "TradeOffer", "TradeEvent"],
        "trading state",
      ],
      [
        fs.readFileSync(proposalsStatePath, "utf8"),
        ["TermAmendmentProposal", "ProposalVote", "ProposerCooldown"],
        "proposal state",
      ],
      [
        fs.readFileSync(poolsStatePath, "utf8"),
        ["AuthorizedPoolOperator", "PoolState", "PendingPoolChange", "PoolDeposit"],
        "pool state",
      ],
    ];

    for (const [source, accounts, scope] of stateSources) {
      for (const accountName of accounts) {
        assert.match(
          source,
          new RegExp(
            `pub struct ${accountName}[\\s\\S]*?pub _reserved: \\[u8;[^\\]]+\\],[\\s\\S]*?pub account_version: u16,`,
          ),
          `${scope} ${accountName} should keep _reserved bytes and account_version tail fields`,
        );
      }
    }
  });

  it("pins escrow USDC ATA ownership to escrow PDA in recall contexts", () => {
    const source = fs.readFileSync(lendingContextsPath, "utf8");
    const matches = source.match(/constraint = escrow_usdc_ata\.owner == escrow\.key\(\)/g) ?? [];
    assert.isAtLeast(
      matches.length,
      2,
      "expected escrow_usdc_ata ownership guard to exist in recall contexts",
    );
  });

  it("requires borrower ownership in all revolving borrower contexts", () => {
    const source = fs.readFileSync(revolvingContextsPath, "utf8");
    const guardedContexts = [
      "DrawFromRevolving",
      "RepayRevolving",
      "CloseRevolvingFacility",
    ];
    for (const contextName of guardedContexts) {
      assert.match(
        source,
        new RegExp(
          `pub struct ${contextName}[\\s\\S]*?has_one = borrower @ StendarError::UnauthorizedPayment`,
        ),
        `${contextName} borrower has_one guard missing`,
      );
    }
  });

  it("keeps standby fee distribution restricted to treasury bot authority", () => {
    const source = fs.readFileSync(revolvingContextsPath, "utf8");
    assert.include(
      source,
      "constraint = treasury.bot_authority == bot_authority.key() @ StendarError::UnauthorizedBotOperation",
      "revolving standby fee bot authorization guard missing",
    );
  });

  it("keeps processor-driven contract updates behind treasury bot authority", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.include(
      source,
      "treasury.bot_authority == ctx.accounts.bot_authority.key()",
      "update/distribution processor authorization guard missing",
    );
  });

  it("keeps global initialize restricted to upgrade authority context", () => {
    const source = fs.readFileSync(lendingContextsPath, "utf8");
    assert.include(
      source,
      "program_data.upgrade_authority_address == Some(authority.key())",
      "initialize upgrade-authority guard missing",
    );
  });

  it("rejects principal-path payments for revolving contracts", () => {
    const source = fs.readFileSync(paymentInstructionsPath, "utf8");
    assert.include(
      source,
      "StendarError::RevolvingPaymentMustUseRepay",
      "revolving payment flow must reject principal-path payments",
    );
  });

  it("keeps borrower authorization anchored in payment contexts", () => {
    const source = fs.readFileSync(paymentContextsPath, "utf8");
    for (const contextName of ["MakePayment", "MakePaymentWithDistribution"]) {
      assert.match(
        source,
        new RegExp(
          `pub struct ${contextName}[\\s\\S]*?has_one = borrower @ StendarError::UnauthorizedPayment`,
        ),
        `${contextName} must keep has_one borrower authorization`,
      );
    }
  });

  it("keeps revolving creation constraints for standby rate and principal schedule", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.include(
      source,
      "StendarError::InvalidStandbyFeeRate",
      "revolving standby fee rate guard missing",
    );
    assert.include(
      source,
      "StendarError::RevolvingPrincipalPaymentNotAllowed",
      "revolving principal payment guard missing",
    );
  });

  it("accrues revolving standby fees from credit_limit minus drawn_amount", () => {
    const source = fs.readFileSync(interestUtilsPath, "utf8");
    assert.match(
      source,
      /pub fn checkpoint_standby_fees[\s\S]*?let undrawn_amount = contract[\s\S]*?\.credit_limit[\s\S]*?\.(?:checked_sub|saturating_sub)\(contract\.drawn_amount\)/,
      "revolving standby accrual must use credit_limit - drawn_amount as the undrawn base",
    );
  });

  it("reduces revolving availability when distributing standby fees", () => {
    const source = fs.readFileSync(revolvingInstructionsPath, "utf8");
    assert.match(
      source,
      /if !contract\.revolving_closed \{[\s\S]*?contract\.available_amount = contract[\s\S]*?\.available_amount[\s\S]*?\.saturating_sub\(distributed_standby\);/,
      "standby fee distribution must reduce available amount while the facility remains open",
    );
  });

  it("requires sufficient contract pool balance before standby fee distribution", () => {
    const source = fs.readFileSync(revolvingInstructionsPath, "utf8");
    assert.match(
      source,
      /pub fn distribute_standby_fees[\s\S]*?contract_usdc_account\.amount >= standby_fee_amount[\s\S]*?StendarError::InsufficientContractBalance/,
      "standby fee distribution must fail with a descriptive error when the contract pool is underfunded",
    );
  });

  it("keeps committed-only early termination fees for revolving facility close", () => {
    const source = fs.readFileSync(revolvingInstructionsPath, "utf8");
    assert.match(
      source,
      /if contract\.loan_type == LoanType::Committed[\s\S]*?&& contract\.term_days > 0[\s\S]*?&& available_before_close > 0[\s\S]*?\{/,
      "early termination fee gate should remain committed-only and require term + undrawn availability",
    );
  });

  it("keeps add_collateral restricted to the borrower signer", () => {
    const source = fs.readFileSync(lendingContextsPath, "utf8");
    assert.match(
      source,
      /pub struct AddCollateral[\s\S]*?constraint = borrower\.key\(\) == contract\.borrower @ StendarError::UnauthorizedPayment[\s\S]*?pub borrower: Signer<'info>,/,
      "AddCollateral must constrain borrower ownership and signer authorization",
    );
  });

  it("keeps claim_from_escrow restricted to the escrow lender signer", () => {
    const source = fs.readFileSync(lendingContextsPath, "utf8");
    assert.match(
      source,
      /pub struct ClaimFromEscrow[\s\S]*?constraint = escrow\.lender == lender\.key\(\) @ StendarError::UnauthorizedClaim[\s\S]*?pub lender: Signer<'info>,/,
      "ClaimFromEscrow must require lender signer that matches escrow.lender",
    );
  });

  it("keeps request_recall bound to lender-owned contributions", () => {
    const source = fs.readFileSync(lendingContextsPath, "utf8");
    assert.match(
      source,
      /pub struct RequestRecall[\s\S]*?constraint = contribution\.contract == contract\.key\(\) @ StendarError::InvalidContribution,[\s\S]*?constraint = contribution\.lender == lender\.key\(\) @ StendarError::UnauthorizedClaim,/,
      "RequestRecall must validate both contribution-contract and contribution-lender relationships",
    );
  });

  it("keeps cancel_contract restricted to the borrower", () => {
    const source = fs.readFileSync(lendingContextsPath, "utf8");
    assert.match(
      source,
      /pub struct CancelContract[\s\S]*?constraint = borrower\.key\(\) == contract\.borrower @ StendarError::UnauthorizedCancellation/,
      "CancelContract borrower authorization guard missing",
    );
  });

  it("includes standby fee obligations in revolving liquidation debt", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.match(
      source,
      /fn calculate_liquidation_debt[\s\S]*?if contract\.is_revolving[\s\S]*?contract\.accrued_standby_fees/,
      "revolving liquidation debt must include accrued standby fees",
    );
  });

  it("requires all revolving completion conditions in completion predicate", () => {
    const source = fs.readFileSync(interestUtilsPath, "utf8");
    assert.match(
      source,
      /pub fn check_revolving_completion\(contract: &DebtContract\) -> bool[\s\S]*?contract\.revolving_closed[\s\S]*?contract\.drawn_amount == 0[\s\S]*?contract\.accrued_interest == 0[\s\S]*?contract\.accrued_standby_fees == 0/,
      "revolving completion predicate must check closed, zero drawn, and zero fee balances",
    );
  });

  it("caps revolving accrued interest to the protocol multiplier of credit_limit", () => {
    const source = fs.readFileSync(interestUtilsPath, "utf8");
    assert.match(
      source,
      /if contract\.is_revolving[\s\S]*?let max_accrued_interest = contract[\s\S]*?\.credit_limit[\s\S]*?\.saturating_mul\(MAX_OUTSTANDING_BALANCE_MULTIPLIER\);[\s\S]*?if contract\.accrued_interest > max_accrued_interest \{[\s\S]*?contract\.accrued_interest = max_accrued_interest;/,
      "revolving interest accrual must cap accrued_interest using the protocol multiplier",
    );
  });

  it("keeps recall debt-share proportional across loan types", () => {
    const source = fs.readFileSync(interestUtilsPath, "utf8");
    assert.notInclude(
      source,
      "return Ok(contribution_amount);",
      "non-revolving recalls must not bypass proportional debt-share math",
    );
    assert.match(
      source,
      /pub fn calculate_recall_debt_share[\s\S]*?checked_mul\(contribution_amount as u128\)[\s\S]*?checked_div\(funded_amount as u128\)/,
      "recall debt-share calculation must remain proportional to outstanding_balance/funded_amount",
    );
  });

  it("requires bot authority for v1 liquidation path", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.include(
      source,
      "treasury.bot_authority == liquidator_key",
      "v1 liquidation bot authorization guard missing",
    );
  });

  it("keeps liquidation gated to active or pending-recall contracts", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.match(
      source,
      /pub fn liquidate_contract[\s\S]*?contract\.status == ContractStatus::Active[\s\S]*?\|\| contract\.status == ContractStatus::PendingRecall[\s\S]*?StendarError::ContractNotEligibleForLiquidation/,
      "liquidate_contract must reject already-liquidated/completed/cancelled contracts",
    );
  });

  it("removes legacy compat liquidation path", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.notInclude(
      source,
      "_liquidate_contract_compat",
      "legacy compat liquidation path should not exist",
    );
  });

  it("reconciles state debt and collateral totals during partial liquidation", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.include(
      source,
      "apply_partial_liquidation_state_updates(&mut ctx.accounts.state, capped_repay, actual_seize)?;",
      "partial liquidation state totals reconciliation missing",
    );
  });

  it("uses total liquidation debt for partial liquidation health checks", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.match(
      source,
      /pub fn partial_liquidate[\s\S]*?let debt_for_ltv = calculate_liquidation_debt\(contract\)\?/,
      "partial liquidation must use calculate_liquidation_debt for health checks",
    );
  });

  it("caps partial liquidation repay by outstanding balance for all loan types", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.match(
      source,
      /pub fn partial_liquidate[\s\S]*?let max_repay = std::cmp::min\(max_repay, contract\.outstanding_balance\);/,
      "partial liquidation repay cap must clamp to outstanding_balance",
    );
  });

  it("allows pending recall status in partial liquidation", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.match(
      source,
      /pub fn partial_liquidate[\s\S]*?contract\.status == ContractStatus::Active[\s\S]*?\|\|[\s\S]*?contract\.status == ContractStatus::PendingRecall[\s\S]*?StendarError::ContractNotEligibleForLiquidation/,
      "partial liquidation must accept PendingRecall contracts",
    );
  });

  it("emits contract liquidation events in both full and partial paths", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    const matches = source.match(/emit!\(ContractLiquidated \{/g) ?? [];
    assert.isAtLeast(
      matches.length,
      2,
      "expected ContractLiquidated events in both full and partial liquidation flows",
    );
  });

  it("derives partial completion residual collateral after prior seizure transfer", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.match(
      source,
      /if completed_by_partial_liquidation[\s\S]*?let residual_collateral =[\s\S]*?contract_collateral_ata[\s\S]*?\.amount[\s\S]*?\.saturating_sub\(actual_seize\)/,
      "partial completion must compute residual collateral as pre-transfer amount minus seized amount",
    );
  });

  it("allows partial completion to proceed without borrower collateral ATA fallback", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.match(
      source,
      /if completed_by_partial_liquidation[\s\S]*?if let Some\(borrower_collateral_ata\) = ctx\.accounts\.borrower_collateral_ata\.as_ref\(\)/,
      "partial completion should guard borrower_collateral_ata as optional fallback",
    );
  });

  it("uses saturating collateral telemetry updates in liquidation and recall paths", () => {
    const lendingSource = fs.readFileSync(lendingInstructionsPath, "utf8");
    const proposalsSource = fs.readFileSync(proposalsInstructionsPath, "utf8");
    for (const contextLabel of [
      "finalize_full_liquidation.total_collateral",
      "apply_partial_liquidation_state_updates.total_collateral",
      "borrower_repay_recall.total_collateral",
      "process_recall.total_collateral",
    ]) {
      assert.include(
        lendingSource,
        contextLabel,
        `lending path ${contextLabel} should use saturating telemetry update`,
      );
    }
    assert.include(
      proposalsSource,
      "process_proposal_recall.total_collateral",
      "proposal recall should use saturating telemetry update",
    );
  });

  it("tracks revolving principal in state.total_debt on draw and repay", () => {
    const source = fs.readFileSync(revolvingInstructionsPath, "utf8");
    assert.match(
      source,
      /draw_from_revolving[\s\S]*?ctx\.accounts\.state\.total_debt = ctx[\s\S]*?\.total_debt[\s\S]*?\.checked_add\(amount\)/,
      "draw_from_revolving must increase state.total_debt by the drawn principal",
    );
    assert.match(
      source,
      /repay_revolving[\s\S]*?ctx\.accounts\.state\.total_debt = ctx[\s\S]*?\.total_debt[\s\S]*?\.checked_sub\(amount\)/,
      "repay_revolving must reduce state.total_debt by repaid principal",
    );
  });

  it("keeps revolving draws gated by active status and closed facility flag", () => {
    const source = fs.readFileSync(revolvingInstructionsPath, "utf8");
    const drawFromRevolvingBody = extractRustFunctionBody(
      source,
      "draw_from_revolving",
    );
    assert.include(
      drawFromRevolvingBody,
      "contract.status == ContractStatus::Active",
      "draw_from_revolving must require Active status and reject closed facilities",
    );
    assert.include(
      drawFromRevolvingBody,
      "!ctx.accounts.contract.revolving_closed",
      "draw_from_revolving must require Active status and reject closed facilities",
    );
  });

  // P0-REV-PAUSE: static pause regression marker.
  it("requires platform to be unpaused before revolving draws", () => {
    const source = fs.readFileSync(revolvingInstructionsPath, "utf8");
    const drawFromRevolvingBody = extractRustFunctionBody(
      source,
      "draw_from_revolving",
    );
    assert.include(
      drawFromRevolvingBody,
      "!ctx.accounts.state.is_paused",
      "draw_from_revolving must check state pause flag in its own function body",
    );
    assert.include(
      drawFromRevolvingBody,
      "StendarError::PlatformPaused",
      "draw_from_revolving must reject draws with PlatformPaused in its own function body",
    );
  });

  it("requires contract USDC liquidity for revolving draws", () => {
    const source = fs.readFileSync(revolvingInstructionsPath, "utf8");
    assert.match(
      source,
      /draw_from_revolving[\s\S]*?amount <= ctx\.accounts\.contract_usdc_account\.amount[\s\S]*?StendarError::InsufficientContractBalance/,
      "draw_from_revolving must verify contract_usdc_account.amount before transfer",
    );
  });

  it("clamps revolving liquidation distribution to actual contract USDC liquidity", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.match(
      source,
      /let \(available_for_distribution, availability_clamped\) = if ctx\.accounts\.contract\.is_revolving \{[\s\S]*?ctx\.accounts\.contract\.available_amount[\s\S]*?\.min\(contract_usdc_ata\.amount\)/,
      "liquidate_contract must clamp available_amount against contract_usdc_ata.amount",
    );
    assert.match(
      source,
      /if availability_clamped \{[\s\S]*?liquidation_available_clamped original=\{\} clamped=\{\} contract_ata_amount=\{\}/,
      "liquidate_contract should emit a clamp log for observability",
    );
  });

  it("keeps create_debt_contract from counting revolving target_amount as principal debt", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.match(
      source,
      /if !is_revolving \{[\s\S]*?state\.total_debt = state[\s\S]*?\.checked_add\(target_amount\)/,
      "create_debt_contract should only add target_amount to total_debt for non-revolving loans",
    );
  });

  it("keeps non-revolving payment paths decrementing state.total_debt by effective principal", () => {
    const source = fs.readFileSync(paymentInstructionsPath, "utf8");
    assert.match(
      source,
      /pub fn make_payment[\s\S]*?reduce_total_debt_by_principal\(\s*state\.total_debt,\s*principal_allocation\.effective_principal,/,
      "make_payment must reduce state.total_debt by effective principal",
    );
    assert.match(
      source,
      /pub fn make_payment_with_distribution[\s\S]*?reduce_total_debt_by_principal\(\s*state\.total_debt,\s*principal_allocation\.effective_principal,/,
      "make_payment_with_distribution must reduce state.total_debt by effective principal",
    );
  });

  it("keeps non-revolving liquidation debt inclusive of accrued interest", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.match(
      source,
      /fn calculate_liquidation_debt[\s\S]*?else \{[\s\S]*?outstanding_balance[\s\S]*?checked_add\(contract\.accrued_interest\)/,
      "non-revolving liquidation debt must include accrued_interest",
    );
  });

  it("keeps full liquidation principal retirement aligned to funded minus paid principal", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.match(
      source,
      /let debt_to_retire = if contract\.is_revolving \{[\s\S]*?contract[\s\S]*?\.funded_amount[\s\S]*?saturating_sub\(contract\.total_principal_paid\)/,
      "full liquidation must retire non-revolving principal from funded_amount - total_principal_paid",
    );
  });

  it("does not overwrite stored frontend attribution during contract creation", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.notInclude(
      source,
      "contract.frontend = Pubkey::default();",
      "frontend attribution must not be overwritten during contract initialization",
    );
  });

  it("keeps committed-loan liquidation maturity trigger inclusive at boundary", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.match(
      source,
      /LoanType::Committed => Ok\(current_time[\s\S]*?>= created_at/,
      "committed loan maturity trigger must use >= boundary",
    );
  });

  it("removes force_reset_platform from program entrypoints and handlers", () => {
    const adminInstructions = fs.readFileSync(adminInstructionsPath, "utf8");
    const programLib = fs.readFileSync(programLibPath, "utf8");
    assert.notInclude(
      adminInstructions,
      "force_reset_platform",
      "force_reset_platform handler should be removed from admin operations",
    );
    assert.notInclude(
      programLib,
      "force_reset_platform",
      "force_reset_platform entrypoint should be removed from lib.rs",
    );
  });

  it("keeps production SDK IDL free of testing-only clock offsets and force reset instruction", () => {
    const idl = fs.readFileSync(sdkIdlPath, "utf8");
    assert.notInclude(idl, "testClockOffset", "production IDL must not expose testClockOffset");
    assert.notInclude(idl, "TestClockOffset", "production IDL must not expose TestClockOffset");
    assert.notInclude(idl, "force_reset_platform", "production IDL must not expose force_reset_platform");
    assert.notInclude(idl, "forceResetPlatform", "production IDL must not expose forceResetPlatform");
  });

  it("requires mutable state account in revolving draw and repay contexts", () => {
    const source = fs.readFileSync(revolvingContextsPath, "utf8");
    for (const contextName of ["DrawFromRevolving", "RepayRevolving"]) {
      assert.match(
        source,
        new RegExp(
          `pub struct ${contextName}[\\s\\S]*?#\\[account\\([\\s\\S]*?mut,[\\s\\S]*?seeds = \\[b\"global_state\"\\],[\\s\\S]*?\\)\\][\\s\\S]*?pub state: Account<'info, State>,`,
        ),
        `${contextName} must declare global state as mutable`,
      );
    }
  });

  it("locks treasury mint configuration at initialization and removes lazy mint initialization", () => {
    const lending = fs.readFileSync(lendingInstructionsPath, "utf8");
    const pools = fs.readFileSync(poolsInstructionsPath, "utf8");
    const proposals = fs.readFileSync(proposalsInstructionsPath, "utf8");
    const admin = fs.readFileSync(adminInstructionsPath, "utf8");

    assert.notInclude(
      lending,
      "if treasury.usdc_mint == Pubkey::default()",
      "lazy treasury usdc_mint initialization must be removed from lending flows",
    );
    assert.notInclude(
      pools,
      "if treasury.usdc_mint == Pubkey::default()",
      "lazy treasury usdc_mint initialization must be removed from pool flows",
    );
    assert.notInclude(
      proposals,
      "if treasury.usdc_mint == Pubkey::default()",
      "lazy treasury usdc_mint initialization must be removed from proposal flows",
    );
    assert.include(
      admin,
      "require!(usdc_mint != Pubkey::default(), StendarError::InvalidMint);",
      "initialize_treasury must reject default mint",
    );
  });

  it("keeps refund_lender restricted to the contribution lender", () => {
    const source = fs.readFileSync(lendingContextsPath, "utf8");
    assert.include(
      source,
      "constraint = contribution.lender == lender.key() @ StendarError::UnauthorizedClaim",
      "refund_lender lender-authorization guard missing",
    );
  });

  it("keeps withdraw_contribution blocked until escrow balances are empty", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    const errors = fs.readFileSync(errorsPath, "utf8");
    const body = extractRustFunctionBody(source, "withdraw_contribution");
    assert.include(
      body,
      "ctx.accounts.escrow.escrow_amount == 0",
      "withdraw_contribution must require escrow principal to be drained",
    );
    assert.include(
      body,
      "ctx.accounts.escrow.available_interest == 0",
      "withdraw_contribution must require escrow interest to be drained",
    );
    assert.include(
      body,
      "ctx.accounts.escrow.available_principal == 0",
      "withdraw_contribution must require escrow principal-claim balance to be drained",
    );
    assert.include(
      body,
      "StendarError::EscrowNotEmpty",
      "withdraw_contribution must fail with EscrowNotEmpty when escrow balances remain",
    );
    assert.include(errors, "EscrowNotEmpty", "errors.rs must define EscrowNotEmpty");
  });

  it("keeps cancel_term_proposal restricted to the proposal creator", () => {
    const source = fs.readFileSync(proposalsContextsPath, "utf8");
    assert.include(
      source,
      "constraint = proposer.key() == proposal.proposer @ StendarError::UnauthorizedProposalCancel",
      "cancel_term_proposal proposer-authorization guard missing",
    );
  });

  it("requires signer authorization when closing proposal accounts", () => {
    const source = fs.readFileSync(proposalsContextsPath, "utf8");
    assert.include(
      source,
      "pub proposer_receiver: Signer<'info>,",
      "close_proposal_accounts must require proposer signer authorization",
    );
  });

  it("blocks closing rejected or expired proposals while pledged recalls remain pending", () => {
    const source = fs.readFileSync(proposalsInstructionsPath, "utf8");
    const closeBody = extractRustFunctionBody(source, "close_proposal_accounts");
    const errors = fs.readFileSync(errorsPath, "utf8");

    assert.include(
      closeBody,
      "proposal_has_pending_recalls_for_close(",
      "close_proposal_accounts must call the pending-recall close guard helper",
    );
    assert.match(
      source,
      /fn proposal_has_pending_recalls_for_close[\s\S]*ProposalStatus::Rejected\s*\|\s*ProposalStatus::Expired/,
      "pending-recall close guard helper must scope guard to rejected/expired proposals",
    );
    assert.match(
      source,
      /fn proposal_has_pending_recalls_for_close[\s\S]*recalls_processed < recall_pledged_count/,
      "pending-recall close guard helper must block closure while pledged recalls remain unprocessed",
    );
    assert.include(
      closeBody,
      "StendarError::ProposalRecallsPending",
      "close_proposal_accounts must fail with ProposalRecallsPending when recalls are pending",
    );
    assert.include(errors, "ProposalRecallsPending", "errors.rs must define ProposalRecallsPending");
  });

  it("requires constrained processor identity for pool withdrawal processing", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "programs/stendar/src/contexts/pools.rs"), "utf8");
    assert.include(
      source,
      "pool.operator == processor.key() || treasury.bot_authority == processor.key()",
      "process_pool_withdrawal processor authorization guard missing",
    );
  });

  it("rejects explicit pool-withdrawal queue requests when queueing is disabled", () => {
    const source = fs.readFileSync(poolsInstructionsPath, "utf8");
    const body = extractRustFunctionBody(source, "request_pool_withdrawal");
    assert.include(
      body,
      "pool.withdrawal_queue_enabled",
      "request_pool_withdrawal must require queueing to be enabled",
    );
    assert.include(
      body,
      "StendarError::PoolWithdrawalQueueDisabled",
      "request_pool_withdrawal must fail with PoolWithdrawalQueueDisabled when queueing is off",
    );
  });

  it("keeps explicit pool-withdrawal queue request flow for enabled queues", () => {
    const source = fs.readFileSync(poolsInstructionsPath, "utf8");
    const body = extractRustFunctionBody(source, "request_pool_withdrawal");
    const errors = fs.readFileSync(errorsPath, "utf8");
    assert.include(
      body,
      "StendarError::PoolWithdrawalAlreadyQueued",
      "request_pool_withdrawal must keep duplicate-request rejection",
    );
    assert.include(
      body,
      "queue_withdrawal_request(pool, pool_deposit, amount, now)?;",
      "request_pool_withdrawal must continue queueing requests when enabled",
    );
    assert.include(
      errors,
      "PoolWithdrawalQueueDisabled",
      "errors.rs must define PoolWithdrawalQueueDisabled",
    );
  });

  it("pins automated bot contract accounts to debt_contract PDA seeds", () => {
    const source = fs.readFileSync(adminContextsPath, "utf8");
    const matches = source.match(/seeds = \[b\"debt_contract\", contract\.borrower\.as_ref\(\), &contract\.contract_seed\.to_le_bytes\(\)\]/g) ?? [];
    assert.isAtLeast(
      matches.length,
      2,
      "automated transfer contexts must include debt_contract PDA seed guards",
    );
  });

  it("pins expire/recall/listing contexts to debt_contract PDA seeds", () => {
    const source = fs.readFileSync(lendingContextsPath, "utf8");
    for (const contextName of ["ExpireContract", "RequestRecall", "CloseListing"]) {
      assert.match(
        source,
        new RegExp(
          `pub struct ${contextName}[\\s\\S]*?seeds = \\[b\"debt_contract\", contract\\.borrower\\.as_ref\\(\\), &contract\\.contract_seed\\.to_le_bytes\\(\\)\\]`,
        ),
        `${contextName} must pin contract account to debt_contract PDA seeds`,
      );
    }
  });

  it("keeps accept_trade_offer restricted to the listing seller", () => {
    const source = fs.readFileSync(tradingContextsPath, "utf8");
    assert.include(
      source,
      "constraint = listing.seller == seller.key() @ StendarError::UnauthorizedAcceptance",
      "accept_trade_offer seller-authorization guard missing",
    );
  });

  it("keeps cancel_trade_listing restricted to the listing seller", () => {
    const source = fs.readFileSync(tradingContextsPath, "utf8");
    assert.include(
      source,
      "constraint = listing.seller == seller.key() @ StendarError::UnauthorizedCancellation",
      "cancel_trade_listing seller-authorization guard missing",
    );
  });

  it("keeps accept_trade_offer buyer identity bound to the offer account", () => {
    const source = fs.readFileSync(tradingContextsPath, "utf8");
    assert.include(
      source,
      "constraint = offer.buyer == buyer.key() @ StendarError::InvalidOffer",
      "accept_trade_offer must bind close recipient and signer to offer.buyer",
    );
  });

  it("enforces transfer_lender_position contract status and PDA seed constraints", () => {
    const source = fs.readFileSync(tradingContextsPath, "utf8");
    assert.match(
      source,
      /pub struct TransferLenderPosition[\s\S]*?seeds = \[DEBT_CONTRACT_SEED, contract\.borrower\.as_ref\(\), &contract\.contract_seed\.to_le_bytes\(\)\][\s\S]*?contract\.status == ContractStatus::Active @ StendarError::ContractNotActive/,
      "transfer_lender_position must pin contract PDA and require active status in context",
    );
  });

  it("keeps phase-2A close recipients pinned to intended principals", () => {
    const tradingSource = fs.readFileSync(tradingContextsPath, "utf8");
    const proposalSource = fs.readFileSync(proposalsContextsPath, "utf8");
    const poolSource = fs.readFileSync(poolsContextsPath, "utf8");

    assert.match(
      tradingSource,
      /pub struct AcceptTradeOffer[\s\S]*?constraint = listing\.seller == seller\.key\(\) @ StendarError::UnauthorizedAcceptance[\s\S]*?close = seller[\s\S]*?constraint = offer\.buyer == buyer\.key\(\) @ StendarError::InvalidOffer[\s\S]*?close = buyer/,
      "accept_trade_offer should close listing to seller and offer to matched buyer",
    );
    assert.match(
      tradingSource,
      /pub struct ExpireTradeListing[\s\S]*?close = seller[\s\S]*?constraint = seller\.key\(\) == listing\.seller @ StendarError::InvalidContractReference/,
      "expire_trade_listing should return rent to listing.seller",
    );
    assert.match(
      tradingSource,
      /pub struct BotCloseTradeEvent[\s\S]*?close = seller[\s\S]*?constraint = seller\.key\(\) == trade_event\.seller @ StendarError::InvalidContractReference/,
      "bot_close_trade_event should return rent to trade_event.seller",
    );

    assert.match(
      proposalSource,
      /pub struct CloseProposalAccounts[\s\S]*?close = proposer_receiver[\s\S]*?pub proposer_receiver: Signer<'info>,/,
      "close_proposal_accounts should close into proposer signer receiver",
    );

    assert.match(
      poolSource,
      /pub struct ClosePool[\s\S]*?close = operator[\s\S]*?constraint = pool\.operator == operator\.key\(\) @ StendarError::InvalidPoolOperator/,
      "close_pool should return pool rent to operator",
    );
    assert.match(
      poolSource,
      /pub struct ExpireIdlePool[\s\S]*?close = operator_receiver[\s\S]*?constraint = operator_receiver\.key\(\) == pool\.operator @ StendarError::InvalidPoolOperator/,
      "expire_idle_pool should return closed pool rent to pool.operator",
    );
    assert.match(
      poolSource,
      /pub pending_change: Option<Account<'info, PendingPoolChange>>,/,
      "expire_idle_pool should keep optional pending change close path",
    );
  });

  it("keeps create_trade_listing blocked while proposals are active", () => {
    const source = fs.readFileSync(tradingInstructionsPath, "utf8");
    const createListingBody = extractRustFunctionBody(source, "create_trade_listing");
    assert.include(
      createListingBody,
      "!contract.has_active_proposal",
      "create_trade_listing must block listings while a proposal is active",
    );
    assert.include(
      createListingBody,
      "StendarError::ProposalAlreadyActive",
      "create_trade_listing must fail with ProposalAlreadyActive for active proposals",
    );
  });

  it("keeps accept_trade_offer blocked while proposals are active", () => {
    const source = fs.readFileSync(tradingInstructionsPath, "utf8");
    const acceptTradeOfferBody = extractRustFunctionBody(source, "accept_trade_offer");
    assert.include(
      acceptTradeOfferBody,
      "!contract.has_active_proposal",
      "accept_trade_offer must block trade acceptance while a proposal is active",
    );
    assert.include(
      acceptTradeOfferBody,
      "StendarError::ProposalAlreadyActive",
      "accept_trade_offer must fail with ProposalAlreadyActive for active proposals",
    );
  });

  it("keeps transfer_lender_position blocked while proposals are active", () => {
    const source = fs.readFileSync(tradingInstructionsPath, "utf8");
    const transferBody = extractRustFunctionBody(source, "transfer_lender_position");
    assert.include(
      transferBody,
      "!ctx.accounts.contract.has_active_proposal",
      "transfer_lender_position must block direct transfers while a proposal is active",
    );
    assert.include(
      transferBody,
      "StendarError::ProposalAlreadyActive",
      "transfer_lender_position must fail with ProposalAlreadyActive for active proposals",
    );
  });

  it("enforces platform pause checks across trading entrypoints", () => {
    const source = fs.readFileSync(tradingInstructionsPath, "utf8");
    for (const functionName of [
      "create_trade_listing",
      "create_trade_offer",
      "accept_trade_offer",
      "transfer_lender_position",
    ]) {
      const body = extractRustFunctionBody(source, functionName);
      assert.match(
        body,
        /require!\(!ctx\.accounts\.state\.is_paused,\s*StendarError::PlatformPaused\);/,
        `${functionName} must block execution while the platform is paused`,
      );
    }
  });

  it("keeps accept_trade_offer expiry guards for both listing and offer", () => {
    const source = fs.readFileSync(tradingInstructionsPath, "utf8");
    const body = extractRustFunctionBody(source, "accept_trade_offer");
    assert.include(
      body,
      "StendarError::TradeListingExpired",
      "accept_trade_offer must fail when listing validity has expired",
    );
    assert.include(
      body,
      "StendarError::TradeOfferExpired",
      "accept_trade_offer must fail when offer validity has expired",
    );
  });

  it("keeps trading risk math monotonic with collateralization", () => {
    const source = fs.readFileSync(tradingUtilsPath, "utf8");
    assert.match(
      source,
      /let collateralization_adjustment: u128 = if collateralization_bps < 6000[\s\S]*?9800[\s\S]*?else if collateralization_bps < 8000[\s\S]*?9900[\s\S]*?else[\s\S]*?10000/,
      "risk adjustment must discount lower collateralization and avoid penalizing higher collateralization",
    );
    assert.include(
      source,
      "fn risk_adjustment_is_monotonic_with_collateralization()",
      "utils/trading.rs should keep explicit monotonic collateralization coverage for risk adjustment",
    );
    assert.include(
      source,
      "fn position_value_is_monotonic_with_collateralization()",
      "utils/trading.rs should keep explicit monotonic collateralization coverage for fair value",
    );
  });

  it("keeps calculate_position_value constrained to matching contract + contribution", () => {
    const source = fs.readFileSync(tradingContextsPath, "utf8");
    assert.include(
      source,
      "constraint = contribution.contract == contract.key() @ StendarError::InvalidContractReference",
      "calculate_position_value must enforce contribution.contract == contract.key()",
    );
  });

  it("keeps bot_close_trade_event closer authorization in context constraints", () => {
    const source = fs.readFileSync(tradingContextsPath, "utf8");
    assert.include(
      source,
      "constraint = closer.key() == treasury.bot_authority || closer.key() == state.authority",
      "bot_close_trade_event closer authorization should be enforced in account constraints",
    );
  });

  it("ensures operator_return_deposit destination ATA is owned by depositor", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "programs/stendar/src/contexts/pools.rs"), "utf8");
    const contextMatch = source.match(
      /pub struct OperatorReturnDeposit<'info> \{[\s\S]*?\n\}/,
    );
    assert.isNotNull(contextMatch, "OperatorReturnDeposit context block not found");
    const contextSource = contextMatch![0];
    assert.include(
      contextSource,
      "constraint = depositor_usdc_ata.owner == depositor.key() @ StendarError::TokenAccountMismatch",
      "OperatorReturnDeposit must validate depositor_usdc_ata ownership at the context level",
    );
  });

  it("enforces loan-mint constraints for optional trading settlement token accounts", () => {
    const source = fs.readFileSync(tradingContextsPath, "utf8");
    for (const contextName of ["AcceptTradeOffer", "TransferLenderPosition"]) {
      const contextMatch = source.match(
        new RegExp(`pub struct ${contextName}<'info> \\{[\\s\\S]*?\\n\\}`),
      );
      assert.isNotNull(contextMatch, `${contextName} context block not found`);
      const contextSource = contextMatch![0];
      assert.match(
        contextSource,
        /#\[account\([\s\S]*?token::mint = contract\.loan_mint[\s\S]*?\)\]\s*pub buyer_usdc_account: Option<Account<'info, TokenAccount>>,/,
        `${contextName} buyer_usdc_account must be pinned to contract.loan_mint`,
      );
      assert.match(
        contextSource,
        /#\[account\([\s\S]*?token::mint = contract\.loan_mint[\s\S]*?\)\]\s*pub seller_usdc_account: Option<Account<'info, TokenAccount>>,/,
        `${contextName} seller_usdc_account must be pinned to contract.loan_mint`,
      );
      assert.match(
        contextSource,
        /#\[account\([\s\S]*?token::mint = contract\.loan_mint[\s\S]*?\)\]\s*pub treasury_usdc_account: Option<Account<'info, TokenAccount>>,/,
        `${contextName} treasury_usdc_account must be pinned to contract.loan_mint`,
      );
    }
  });

  it("keeps Cargo default features free of testing flags", () => {
    const source = fs.readFileSync(cargoTomlPath, "utf8");
    assert.match(
      source,
      /\[features\][\s\S]*default = \[\]/,
      "Cargo default feature set must remain empty for mainnet builds",
    );
  });

  it("uses stricter confidence threshold for liquidations", () => {
    const source = fs.readFileSync(oracleUtilsPath, "utf8");
    assert.include(
      source,
      "pub const MAX_CONFIDENCE_BPS_STANDARD: u64 = 200;",
      "standard confidence threshold constant missing",
    );
    assert.include(
      source,
      "pub const MAX_CONFIDENCE_BPS_LIQUIDATION: u64 = 100;",
      "liquidation confidence threshold constant missing",
    );
  });

  it("gates AddCollateralType oracle owner checks by build feature", () => {
    const source = fs.readFileSync(collateralContextsPath, "utf8");
    assert.include(
      source,
      "#[cfg(not(feature = \"testing\"))]",
      "production oracle owner guard should be feature-gated",
    );
    assert.include(
      source,
      "#[cfg(feature = \"testing\")]",
      "testing oracle owner guard should be feature-gated",
    );
  });
});
