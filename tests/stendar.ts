import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  getAccount,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { airdropSol, findMintableCollateralEntry, isValidSplMint, refundTrackedKeypairs } from "./test_helpers.ts";

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

  const workspaceProgram: any = anchor.workspace.Stendar;
  const programId = new PublicKey(
    process.env.STENDAR_PROGRAM_ID ??
      process.env.SOLANA_PROGRAM_ID ??
      workspaceProgram.programId.toBase58(),
  );
  const program: any = new Program<any>(
    {
      ...(workspaceProgram.idl as Record<string, unknown>),
      address: programId.toBase58(),
    } as any,
    provider,
  );

  const connection = provider.connection;

  after(async () => {
    await refundTrackedKeypairs(connection);
  });

  const payer = (provider.wallet as any).payer as anchor.web3.Keypair;

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
  const [collateralRegistryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("collateral_registry")],
    program.programId,
  );

  let guardUsdcMint: PublicKey;
  let guardCollateralMint: PublicKey;
  let guardOraclePriceFeed: PublicKey;
  let treasuryUsdcAta: PublicKey;

  function mockOraclePda(seed: number): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle_price_feed"), new anchor.BN(seed).toArrayLike(Buffer, "le", 8)],
      program.programId,
    )[0];
  }

  async function ensurePlatformInitialized(): Promise<void> {
    const stateInfo = await connection.getAccountInfo(statePda);
    if (!stateInfo) {
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

    const treasuryInfo = await connection.getAccountInfo(treasuryPda);
    if (!treasuryInfo) {
      await program.methods
        .initializeTreasury(provider.wallet.publicKey)
        .accountsPartial({
          state: statePda,
          treasury: treasuryPda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  }

  async function initInfrastructure(): Promise<void> {
    try {
      const treasury = await program.account.treasury.fetch(treasuryPda);
      if (!treasury.usdcMint.equals(PublicKey.default) && await isValidSplMint(connection, treasury.usdcMint)) {
        guardUsdcMint = treasury.usdcMint;
      } else {
        guardUsdcMint = await createMint(connection, payer, provider.wallet.publicKey, null, 6);
      }
    } catch {
      guardUsdcMint = await createMint(connection, payer, provider.wallet.publicKey, null, 6);
    }
    guardCollateralMint = await createMint(connection, payer, provider.wallet.publicKey, null, 8);

    const feedSeed = 88801;
    const feedPda = mockOraclePda(feedSeed);
    const slot = await connection.getSlot("confirmed");
    const blockTime = await connection.getBlockTime(slot);
    const publishTime = blockTime ?? Math.floor(Date.now() / 1000);

    const oracleInfo = await connection.getAccountInfo(feedPda);
    if (oracleInfo === null) {
      await program.methods
        .initializeMockOraclePriceFeed(new anchor.BN(feedSeed), new anchor.BN(200_000_000), -8, new anchor.BN(publishTime))
        .accounts({ authority: provider.wallet.publicKey, state: statePda, mockOraclePriceFeed: feedPda, systemProgram: SystemProgram.programId })
        .rpc();
    } else {
      await program.methods
        .setMockOraclePriceFeed(new anchor.BN(200_000_000), -8, new anchor.BN(publishTime))
        .accounts({ authority: provider.wallet.publicKey, state: statePda, mockOraclePriceFeed: feedPda })
        .rpc();
    }
    guardOraclePriceFeed = feedPda;

    const regInfo = await connection.getAccountInfo(collateralRegistryPda);
    if (regInfo === null) {
      await program.methods
        .initializeCollateralRegistry()
        .accounts({ authority: provider.wallet.publicKey, state: statePda, collateralRegistry: collateralRegistryPda, systemProgram: SystemProgram.programId })
        .rpc();
    }

    await (program as any).methods
      .resetCollateralRegistry()
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        collateralRegistry: collateralRegistryPda,
      })
      .rpc();

    await (program as any).methods
      .resetTreasuryUsdcMint(guardUsdcMint)
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        treasury: treasuryPda,
      })
      .rpc();

    await (program as any).methods
      .updateBotAuthority()
      .accounts({
        treasury: treasuryPda,
        authority: provider.wallet.publicKey,
        newBotAuthority: provider.wallet.publicKey,
      })
      .rpc();

    let collateralRegistered = false;
    try {
      await program.methods
        .addCollateralType(guardOraclePriceFeed, 8, 500, 11_000)
        .accounts({ authority: provider.wallet.publicKey, state: statePda, collateralRegistry: collateralRegistryPda, collateralMint: guardCollateralMint, oraclePriceFeed: guardOraclePriceFeed, systemProgram: SystemProgram.programId })
        .rpc();
      collateralRegistered = true;
    } catch (e: any) {
      if (String(e).includes("CollateralRegistryFull")) {
        const registry = await program.account.collateralRegistry.fetch(collateralRegistryPda);
        const active = findMintableCollateralEntry(registry.collateralTypes as any[], provider.wallet.publicKey);
        if (active) {
          guardCollateralMint = active.mint;
          guardOraclePriceFeed = active.oraclePriceFeed;
          const nowSlot = await connection.getSlot("confirmed");
          const nowTime = await connection.getBlockTime(nowSlot);
          await program.methods
            .setMockOraclePriceFeed(new anchor.BN(200_000_000), -8, new anchor.BN(nowTime ?? Math.floor(Date.now() / 1000)))
            .accounts({ authority: provider.wallet.publicKey, state: statePda, mockOraclePriceFeed: guardOraclePriceFeed })
            .rpc();
          collateralRegistered = true;
        }
      } else if (!String(e).includes("DuplicateCollateralMint")) {
        throw e;
      } else {
        collateralRegistered = true;
      }
    }

    treasuryUsdcAta = (await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, treasuryPda, true)).address;
  }

  before(async () => {
    await ensurePlatformInitialized();
    await initInfrastructure();
  });

  beforeEach(async () => {
    const freshPublishTime = new anchor.BN(Math.floor(Date.now() / 1000));
    try {
      await (program as any).methods
        .setMockOraclePriceFeed(
          new anchor.BN(200_000_000),
          -8,
          freshPublishTime,
        )
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: guardOraclePriceFeed,
        })
        .rpc();
    } catch { }
  });

  it("Initializes the platform state (PDA)", async () => {
    const state = await program.account.state.fetch(statePda);
    assert.ok(state.authority.equals(provider.wallet.publicKey));
    assert.isAtLeast(state.totalDebt.toNumber(), 0);
  });

  it("Creates a debt contract (PDA)", async () => {
    const borrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower, 0.1);

    const contractSeed = new anchor.BN(9001);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = new anchor.BN(1_000_000);
    const collateralAmount = new anchor.BN(200_000_000);
    const expectedPrimaryListingFee = BigInt(targetAmount.toString()) / 100_000n;
    const treasuryBalanceBefore = (await getAccount(connection, treasuryUsdcAta)).amount;

    const borrowerCollateralAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardCollateralMint, borrower.publicKey);
    const contractCollateralAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardCollateralMint, contractPda, true);
    const borrowerUsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, borrower.publicKey);
    const contractUsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, contractPda, true);

    await mintTo(connection, payer, guardCollateralMint, borrowerCollateralAta.address, provider.wallet.publicKey, BigInt(200_000_000));
    await mintTo(connection, payer, guardUsdcMint, borrowerUsdcAta.address, provider.wallet.publicKey, BigInt(1_500_000));

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(1000),
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(11_000),
        11_000,
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        14,
        true,
        false,
        0,
        { manual: {} },
        { public: {} },
      )
      .accounts({
        contract: contractPda,
        operationsFund: operationsFundPda,
        state: statePda,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        systemProgram: SystemProgram.programId,
        collateralRegistry: collateralRegistryPda,
        collateralMint: guardCollateralMint,
        borrowerCollateralAta: borrowerCollateralAta.address,
        contractCollateralAta: contractCollateralAta.address,
        priceFeedAccount: guardOraclePriceFeed,
        usdcMint: guardUsdcMint,
        contractUsdcAta: contractUsdcAta.address,
        borrowerUsdcAta: borrowerUsdcAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([borrower])
      .rpc();

    const contract = await program.account.debtContract.fetch(contractPda);
    assert.ok(contract.borrower.equals(borrower.publicKey));
    expectAnchorEnumVariant(contract.status, "openNotFunded");
    assert.equal(contract.targetAmount.toNumber(), targetAmount.toNumber());
    assert.equal(contract.maxLenders, 14);
    assert.equal(
      contract.listingFeePaid.toString(),
      expectedPrimaryListingFee.toString(),
      "primary listing fee should be 0.001% of target amount",
    );

    const treasuryBalanceAfter = (await getAccount(connection, treasuryUsdcAta)).amount;
    assert.equal(
      (treasuryBalanceAfter - treasuryBalanceBefore).toString(),
      expectedPrimaryListingFee.toString(),
      "treasury should receive primary listing fee",
    );

    const opsAccountInfo = await connection.getAccountInfo(operationsFundPda);
    if (opsAccountInfo) {
      const opsFund = await program.account.contractOperationsFund.fetch(operationsFundPda);
      assert.ok(opsFund.contract.equals(contractPda));
      assert.ok(opsFund.borrower.equals(borrower.publicKey));
      assert.isTrue(opsFund.isActive);
      assert.equal(opsFund.maxLenders, 14);
      assert.equal(opsFund.totalReimbursed.toNumber(), 0);
      assert.equal(opsFund.estimatedOperations, 0);
      assert.equal(opsFund.completedOperations, 0);
    }
  });

  it("updates fee rates with authority and supports partial updates", async () => {
    const before = await program.account.state.fetch(statePda);
    const originalSecondaryListingFee = before.secondaryListingFeeBps;

    await program.methods
      .updateFeeRates(5, 6, 7, null, 9)
      .accounts({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const updated = await program.account.state.fetch(statePda);
    assert.equal(updated.poolDepositFeeBps, 5);
    assert.equal(updated.poolYieldFeeBps, 6);
    assert.equal(updated.primaryListingFeeBps, 7);
    assert.equal(updated.secondaryBuyerFeeBps, 9);
    assert.equal(
      updated.secondaryListingFeeBps,
      originalSecondaryListingFee,
      "secondary listing fee should remain unchanged when None is passed",
    );

    // Restore baseline defaults for other test suites.
    await program.methods
      .updateFeeRates(1, 1, 1, 1, 1)
      .accounts({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();
  });

  it("rejects fee updates from non-authority signer", async () => {
    const unauthorized = anchor.web3.Keypair.generate();
    await airdropSol(connection, unauthorized, 0.01);

    let rejected = false;
    try {
      await program.methods
        .updateFeeRates(2, null, null, null, null)
        .accounts({
          state: statePda,
          authority: unauthorized.publicKey,
        })
        .signers([unauthorized])
        .rpc();
    } catch (error) {
      rejected = true;
      const message = String((error as { message?: string })?.message ?? error);
      assert.match(
        message,
        /InvalidAuthority|ConstraintHasOne|has one constraint/i,
        `unexpected rejection error: ${message}`,
      );
    }
    assert.isTrue(rejected, "unauthorized update_fee_rates should fail");
  });

  it("rejects fee values above the configured max bound", async () => {
    let rejected = false;
    try {
      await program.methods
        .updateFeeRates(101, null, null, null, null)
        .accounts({
          state: statePda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
    } catch (error) {
      rejected = true;
      const message = String((error as { message?: string })?.message ?? error);
      assert.match(message, /FeeTooHigh/i, `unexpected rejection error: ${message}`);
    }
    assert.isTrue(rejected, "update_fee_rates should reject values above max bound");
  });
});
