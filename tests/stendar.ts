import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import type { Stendar } from "../target/types/stendar.ts";

const BPF_UPGRADEABLE_LOADER_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

function u64ToLeBytes(value: anchor.BN): Buffer {
  return value.toArrayLike(Buffer, "le", 8);
}

function expectAnchorEnumVariant(enumObj: unknown, expectedKey: string): void {
  assert.isObject(enumObj, "enum is not an object");
  assert.ok(
    Object.prototype.hasOwnProperty.call(enumObj as Record<string, unknown>, expectedKey),
    `expected enum variant '${expectedKey}', got: ${JSON.stringify(enumObj)}`,
  );
}

describe("stendar", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const workspaceProgram = anchor.workspace.Stendar as Program<Stendar>;
  const programId = new PublicKey(
    process.env.STENDAR_PROGRAM_ID ??
      process.env.SOLANA_PROGRAM_ID ??
      workspaceProgram.programId.toBase58(),
  );
  const program = new Program<Stendar>(
    {
      ...(workspaceProgram.idl as unknown as Record<string, unknown>),
      address: programId.toBase58(),
    } as unknown as Stendar,
    provider,
  );

  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_state")],
    program.programId,
  );
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_UPGRADEABLE_LOADER_ID,
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    program.programId,
  );

  async function ensurePlatformInitialized(): Promise<void> {
    try {
      await program.account.state.fetch(statePda);
    } catch {
      await program.methods
        .initialize()
        .accountsPartial({
          state: statePda,
          authority: provider.wallet.publicKey,
          program: program.programId,
          programData: programDataPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    try {
      await program.account.treasury.fetch(treasuryPda);
    } catch {
      await program.methods
        .initializeTreasury(provider.wallet.publicKey)
        .accountsPartial({
          state: statePda,
          treasury: treasuryPda,
          state: statePda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  }

  before(async () => {
    await ensurePlatformInitialized();
  });

  it("Initializes the platform state (PDA)", async () => {
    const state = await program.account.state.fetch(statePda);
    assert.ok(state.authority.equals(provider.wallet.publicKey));
    // Other suites may create contracts before this test runs.
    assert.isAtLeast(state.totalDebt.toNumber(), 0);
  });

  it("Creates a debt contract (PDA)", async () => {
    const borrower = anchor.web3.Keypair.generate();

    // Fund borrower for listing fee + collateral + rent.
    const sig = await provider.connection.requestAirdrop(
      borrower.publicKey,
      5 * anchor.web3.LAMPORTS_PER_SOL,
    );
    const latest = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");

    const contractSeed = new anchor.BN(9001);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const treasuryLamportsBefore = await provider.connection.getBalance(treasuryPda);

    await program.methods
      .createDebtContract(
        contractSeed,
        new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL), // target_amount
        new anchor.BN(1000), // 10% APR (basis points)
        30, // term_days
        new anchor.BN(0.5 * anchor.web3.LAMPORTS_PER_SOL), // collateral_amount
        { committed: {} },
        new anchor.BN(8000), // 80% LTV
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        14, // max_lenders
        true, // partial_funding_enabled
        { manual: {} },
      )
      .accountsPartial({
        contract: contractPda,
        operationsFund: operationsFundPda,
        state: statePda,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        systemProgram: SystemProgram.programId,
        collateralRegistry: null,
        collateralMint: null,
        borrowerCollateralAta: null,
        contractCollateralAta: null,
        priceFeedAccount: null,
        usdcMint: null,
        contractUsdcAta: null,
        tokenProgram: null,
        associatedTokenProgram: null,
      })
      .signers([borrower])
      .rpc();

    const treasuryLamportsAfter = await provider.connection.getBalance(treasuryPda);
    const expectedPctFee = new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL).div(
      new anchor.BN(10_000),
    );
    const expectedFloorFee = new anchor.BN(1_000_000);
    const expectedListingFee = expectedPctFee.gt(expectedFloorFee)
      ? expectedPctFee
      : expectedFloorFee;
    assert.equal(
      treasuryLamportsAfter - treasuryLamportsBefore,
      expectedListingFee.toNumber(),
      "treasury should receive the hybrid platform listing fee",
    );

    const contract = await program.account.debtContract.fetch(contractPda);
    assert.ok(contract.borrower.equals(borrower.publicKey));
    expectAnchorEnumVariant(contract.status, "openNotFunded");
    assert.equal(contract.targetAmount.toNumber(), 1 * anchor.web3.LAMPORTS_PER_SOL);
    assert.equal(contract.maxLenders, 14);

    const opsAccountInfo = await provider.connection.getAccountInfo(operationsFundPda);
    if (opsAccountInfo) {
      const opsFund = await program.account.contractOperationsFund.fetch(operationsFundPda);
      assert.ok(opsFund.contract.equals(contractPda));
      assert.ok(opsFund.borrower.equals(borrower.publicKey));
      assert.isTrue(opsFund.isActive);
      assert.equal(opsFund.maxLenders, 14);
      assert.equal(opsFund.totalReimbursed.toNumber(), 0);
      assert.equal(opsFund.estimatedOperations, 0);
      assert.equal(opsFund.completedOperations, 0);

      const rentMin = await provider.connection.getMinimumBalanceForRentExemption(
        opsAccountInfo.data.length,
      );
      assert.equal(
        opsAccountInfo.lamports,
        rentMin,
        "operations fund should be rent-exempt (no ops cost for this config)",
      );
      assert.equal(
        opsAccountInfo.lamports,
        opsFund.totalFunded.toNumber(),
        "operations fund total_funded should match its lamport balance at creation",
      );
    }
  });
});
