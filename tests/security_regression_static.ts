import { assert } from "chai";
import fs from "fs";
import path from "path";

describe("Security regression static guards", () => {
  const lendingContextsPath = path.join(process.cwd(), "programs/stendar/src/contexts/lending.rs");
  const lendingInstructionsPath = path.join(process.cwd(), "programs/stendar/src/instructions/lending.rs");

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
      "treasury.bot_authority == ctx.accounts.processor.key()",
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
});
