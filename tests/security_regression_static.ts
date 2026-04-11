import { assert } from "chai";
import fs from "fs";
import path from "path";

describe("Security regression static guards", () => {
  const lendingContextsPath = path.join(process.cwd(), "programs/stendar/src/contexts/lending.rs");
  const adminContextsPath = path.join(process.cwd(), "programs/stendar/src/contexts/admin.rs");
  const lendingInstructionsPath = path.join(process.cwd(), "programs/stendar/src/instructions/lending.rs");
  const poolsInstructionsPath = path.join(process.cwd(), "programs/stendar/src/instructions/pools.rs");
  const proposalsInstructionsPath = path.join(process.cwd(), "programs/stendar/src/instructions/proposals.rs");
  const adminInstructionsPath = path.join(process.cwd(), "programs/stendar/src/instructions/admin_operations.rs");
  const cargoTomlPath = path.join(process.cwd(), "programs/stendar/Cargo.toml");
  const oracleUtilsPath = path.join(process.cwd(), "programs/stendar/src/utils/oracle.rs");
  const proposalsContextsPath = path.join(process.cwd(), "programs/stendar/src/contexts/proposals.rs");
  const tradingContextsPath = path.join(process.cwd(), "programs/stendar/src/contexts/trading.rs");
  const collateralContextsPath = path.join(process.cwd(), "programs/stendar/src/contexts/collateral.rs");

  it("pins escrow USDC ATA ownership to escrow PDA in recall contexts", () => {
    const source = fs.readFileSync(lendingContextsPath, "utf8");
    const matches = source.match(/constraint = escrow_usdc_ata\.owner == escrow\.key\(\)/g) ?? [];
    assert.isAtLeast(
      matches.length,
      2,
      "expected escrow_usdc_ata ownership guard to exist in recall contexts",
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

  it("requires bot authority for v1 liquidation path", () => {
    const source = fs.readFileSync(lendingInstructionsPath, "utf8");
    assert.include(
      source,
      "treasury.bot_authority == liquidator_key",
      "v1 liquidation bot authorization guard missing",
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

  it("requires constrained processor identity for pool withdrawal processing", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "programs/stendar/src/contexts/pools.rs"), "utf8");
    assert.include(
      source,
      "pool.operator == processor.key() || treasury.bot_authority == processor.key()",
      "process_pool_withdrawal processor authorization guard missing",
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

  it("keeps accept_trade_offer restricted to the listing seller", () => {
    const source = fs.readFileSync(tradingContextsPath, "utf8");
    assert.include(
      source,
      "constraint = listing.seller == seller.key() @ StendarError::UnauthorizedAcceptance",
      "accept_trade_offer seller-authorization guard missing",
    );
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
