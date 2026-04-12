import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import {
  airdropSol,
  isValidSplMint,
  refundTrackedKeypairs,
} from "./test_helpers.ts";

const BPF_UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

async function warpForwardSlots(
  connection: anchor.web3.Connection,
  slots: number,
): Promise<void> {
  const currentSlot = await connection.getSlot("confirmed");
  const targetSlot = currentSlot + slots;
  await (connection as any)._rpcRequest("warpSlot", [targetSlot]);
}

function u64ToLeBytes(value: anchor.BN): Buffer {
  return value.toArrayLike(Buffer, "le", 8);
}

function toBn(value: bigint | number): anchor.BN {
  return new anchor.BN(value.toString());
}

function expectAnchorEnumVariant(enumObj: unknown, expectedKey: string): void {
  assert.isObject(enumObj, "enum is not an object");
  assert.ok(
    Object.prototype.hasOwnProperty.call(
      enumObj as Record<string, unknown>,
      expectedKey,
    ),
    `expected enum variant '${expectedKey}', got: ${JSON.stringify(enumObj)}`,
  );
}

function extractAnchorErrorMessage(error: unknown): string {
  const anyErr = error as any;
  return (
    anyErr?.error?.errorCode?.code ??
    anyErr?.error?.errorMessage ??
    anyErr?.toString?.() ??
    String(error)
  );
}

describe("Revolving lifecycle", () => {
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
  const payer = (
    provider.wallet as anchor.Wallet & { payer: anchor.web3.Keypair }
  ).payer;

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
  const [testClockOffsetPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("test_clock_offset")],
    program.programId,
  );

  let guardUsdcMint: PublicKey;
  let guardCollateralMint: PublicKey;
  let guardOraclePriceFeed: PublicKey;
  let treasuryUsdcAta: PublicKey;
  let nextOracleSeedCounter = 90_000;

  function nextOracleSeed(): anchor.BN {
    return new anchor.BN(nextOracleSeedCounter++);
  }

  function mockOraclePda(feedSeed: anchor.BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle_price_feed"), u64ToLeBytes(feedSeed)],
      program.programId,
    )[0];
  }

  async function getOnchainUnixTimestamp(): Promise<number> {
    const slot = await connection.getSlot("processed");
    const blockTime = await connection.getBlockTime(slot);
    return blockTime ?? Math.floor(Date.now() / 1000);
  }

  async function upsertMockOraclePrice(
    feedSeed: anchor.BN,
    price: bigint,
  ): Promise<PublicKey> {
    const feedPda = mockOraclePda(feedSeed);
    const publishTime = toBn(await getOnchainUnixTimestamp());
    const existing = await connection.getAccountInfo(feedPda);
    if (existing === null) {
      await program.methods
        .initializeMockOraclePriceFeed(feedSeed, toBn(price), -8, publishTime)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: feedPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      await program.methods
        .setMockOraclePriceFeed(toBn(price), -8, publishTime)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: feedPda,
        })
        .rpc();
    }
    return feedPda;
  }

  async function ensurePlatformInitialized(): Promise<void> {
    const stateInfo = await connection.getAccountInfo(statePda);
    if (!stateInfo) {
      await program.methods
        .initialize()
        .accounts({
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
      guardUsdcMint = await createMint(
        connection,
        payer,
        provider.wallet.publicKey,
        null,
        6,
      );
      await program.methods
        .initializeTreasury(provider.wallet.publicKey, guardUsdcMint)
        .accounts({
          state: statePda,
          treasury: treasuryPda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const treasury = await program.account.treasury.fetch(treasuryPda);
    guardUsdcMint = treasury.usdcMint;
    if (
      guardUsdcMint.equals(PublicKey.default) ||
      !(await isValidSplMint(connection, guardUsdcMint))
    ) {
      throw new Error(
        "Treasury USDC mint is not configured to a valid SPL mint",
      );
    }

    const registryInfo = await connection.getAccountInfo(collateralRegistryPda);
    if (!registryInfo) {
      await program.methods
        .initializeCollateralRegistry()
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: collateralRegistryPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      const hasTesting =
        typeof (program.methods as any).resetCollateralRegistry === "function";
      if (hasTesting) {
        const reg = (await program.account.collateralRegistry.fetch(
          collateralRegistryPda,
        )) as any;
        const activeCount = (reg.collateralTypes as any[]).filter(
          (e: any) => e?.isActive === true,
        ).length;
        if (activeCount >= 8) {
          await (program as any).methods
            .resetCollateralRegistry()
            .accounts({
              authority: provider.wallet.publicKey,
              state: statePda,
              collateralRegistry: collateralRegistryPda,
            })
            .rpc();
        }
      }
    }

    guardCollateralMint = await createMint(
      connection,
      payer,
      provider.wallet.publicKey,
      null,
      8,
    );

    const oracleSeed = nextOracleSeed();
    guardOraclePriceFeed = await upsertMockOraclePrice(oracleSeed, 250_000_000_000n);

    const registry = (await program.account.collateralRegistry.fetch(
      collateralRegistryPda,
    )) as any;
    const existingType = registry.collateralTypes.find((entry: any) =>
      (entry.mint as PublicKey).equals(guardCollateralMint),
    );
    if (!existingType) {
      await (program as any).methods
        .addCollateralType(guardOraclePriceFeed, 8, 500, 11_000)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: collateralRegistryPda,
          collateralMint: guardCollateralMint,
          oraclePriceFeed: guardOraclePriceFeed,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else if (!(existingType.oraclePriceFeed as PublicKey).equals(guardOraclePriceFeed)) {
      await (program as any).methods
        .updateCollateralType(guardCollateralMint, guardOraclePriceFeed, null, null)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: collateralRegistryPda,
          collateralMint: guardCollateralMint,
          oraclePriceFeed: guardOraclePriceFeed,
        })
        .rpc();
    }
  }

  async function ensureBotAuthority(): Promise<void> {
    const treasury = await program.account.treasury.fetch(treasuryPda);
    if (
      !treasury.botAuthority.equals(provider.wallet.publicKey) &&
      treasury.authority.equals(provider.wallet.publicKey)
    ) {
      await program.methods
        .updateBotAuthority()
        .accounts({
          treasury: treasuryPda,
          authority: provider.wallet.publicKey,
          newBotAuthority: provider.wallet.publicKey,
        })
        .rpc();
    }
  }

  async function createContractAccounts(
    borrower: anchor.web3.Keypair,
    contractPda: PublicKey,
    targetUsdc: bigint,
    collateralRaw: bigint,
  ) {
    const borrowerCollateralAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardCollateralMint,
      borrower.publicKey,
    );
    const contractCollateralAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardCollateralMint,
      contractPda,
      true,
    );
    const borrowerUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardUsdcMint,
      borrower.publicKey,
    );
    const contractUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardUsdcMint,
      contractPda,
      true,
    );
    await mintTo(
      connection,
      payer,
      guardCollateralMint,
      borrowerCollateralAta.address,
      provider.wallet.publicKey,
      collateralRaw,
    );
    await mintTo(
      connection,
      payer,
      guardUsdcMint,
      borrowerUsdcAta.address,
      provider.wallet.publicKey,
      targetUsdc + 1_000_000_000n,
    );
    return {
      borrowerCollateralAta: borrowerCollateralAta.address,
      contractCollateralAta: contractCollateralAta.address,
      borrowerUsdcAta: borrowerUsdcAta.address,
      contractUsdcAta: contractUsdcAta.address,
    };
  }

  function contractCreateAccounts(
    contractPda: PublicKey,
    operationsFundPda: PublicKey,
    borrowerKey: PublicKey,
    accts: {
      borrowerCollateralAta: PublicKey;
      contractCollateralAta: PublicKey;
      borrowerUsdcAta: PublicKey;
      contractUsdcAta: PublicKey;
    },
    priceFeedAccount: PublicKey = SystemProgram.programId,
  ) {
    return {
      contract: contractPda,
      operationsFund: operationsFundPda,
      state: statePda,
      treasury: treasuryPda,
      borrower: borrowerKey,
      systemProgram: SystemProgram.programId,
      collateralRegistry: collateralRegistryPda,
      collateralMint: guardCollateralMint,
      borrowerCollateralAta: accts.borrowerCollateralAta,
      contractCollateralAta: accts.contractCollateralAta,
      priceFeedAccount,
      usdcMint: guardUsdcMint,
      contractUsdcAta: accts.contractUsdcAta,
      borrowerUsdcAta: accts.borrowerUsdcAta,
      treasuryUsdcAccount: treasuryUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    };
  }

  async function setupLender(
    lender: anchor.web3.Keypair,
    amount: bigint,
  ): Promise<PublicKey> {
    const lenderUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardUsdcMint,
      lender.publicKey,
    );
    await mintTo(
      connection,
      payer,
      guardUsdcMint,
      lenderUsdcAta.address,
      provider.wallet.publicKey,
      amount,
    );
    return lenderUsdcAta.address;
  }

  function contributeAccounts(
    contractPda: PublicKey,
    contributionPda: PublicKey,
    escrowPda: PublicKey,
    lenderKey: PublicKey,
    borrowerKey: PublicKey,
    lenderUsdcAta: PublicKey,
    contractUsdcAta: PublicKey,
    borrowerUsdcAta: PublicKey,
  ) {
    return {
      contract: contractPda,
      state: statePda,
      contribution: contributionPda,
      escrow: escrowPda,
      lender: lenderKey,
      borrower: borrowerKey,
      approvedFunder: null,
      lenderUsdcAccount: lenderUsdcAta,
      contractUsdcAccount: contractUsdcAta,
      borrowerUsdcAccount: borrowerUsdcAta,
      usdcMint: guardUsdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
  }

  function deriveContractPdas(borrowerKey: PublicKey, contractSeed: anchor.BN): {
    contractPda: PublicKey;
    operationsFundPda: PublicKey;
  } {
    const [contractPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("debt_contract"),
        borrowerKey.toBuffer(),
        u64ToLeBytes(contractSeed),
      ],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );
    return { contractPda, operationsFundPda };
  }

  function deriveContributionAndEscrowPdas(
    contractPda: PublicKey,
    lenderKey: PublicKey,
  ): { contributionPda: PublicKey; escrowPda: PublicKey } {
    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lenderKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lenderKey.toBuffer()],
      program.programId,
    );
    return { contributionPda, escrowPda };
  }

  function revolvingContributionPairsRemainingAccounts(
    pairs: Array<{ contributionPda: PublicKey; escrowPda: PublicKey }>,
  ) {
    return pairs.flatMap((pair) => [
      { pubkey: pair.contributionPda, isSigner: false, isWritable: false },
      { pubkey: pair.escrowPda, isSigner: false, isWritable: false },
    ]);
  }

  function standbyDistributionRemainingAccounts(
    pairs: Array<{
      contributionPda: PublicKey;
      escrowPda: PublicKey;
      escrowUsdcAta: PublicKey;
    }>,
  ) {
    return pairs.flatMap((pair) => [
      { pubkey: pair.contributionPda, isSigner: false, isWritable: false },
      { pubkey: pair.escrowPda, isSigner: false, isWritable: true },
      { pubkey: pair.escrowUsdcAta, isSigner: false, isWritable: true },
    ]);
  }

  function liquidationDistributionRemainingAccounts(
    pairs: Array<{
      contributionPda: PublicKey;
      escrowPda: PublicKey;
      escrowUsdcAta: PublicKey;
    }>,
  ) {
    return pairs.flatMap((pair) => [
      { pubkey: pair.contributionPda, isSigner: false, isWritable: false },
      { pubkey: pair.escrowPda, isSigner: false, isWritable: true },
      { pubkey: pair.escrowUsdcAta, isSigner: false, isWritable: true },
    ]);
  }

  function calculateStandbyFeeRaw(
    undrawnAmount: bigint,
    standbyFeeRateBps: bigint,
    elapsedSeconds: bigint,
  ): bigint {
    if (undrawnAmount === 0n || standbyFeeRateBps === 0n || elapsedSeconds <= 0n) {
      return 0n;
    }
    return (
      (undrawnAmount * standbyFeeRateBps * elapsedSeconds) /
      (365n * 24n * 60n * 60n * 10_000n)
    );
  }

  async function setTestClockOffsetSeconds(
    offsetSeconds: bigint | number,
  ): Promise<PublicKey | null> {
    const methods = program.methods as any;
    if (
      typeof methods.initializeTestClockOffset !== "function" ||
      typeof methods.setTestClockOffset !== "function"
    ) {
      return null;
    }

    const accountInfo = await connection.getAccountInfo(testClockOffsetPda);
    const offset = toBn(offsetSeconds);
    if (accountInfo === null) {
      await methods
        .initializeTestClockOffset(offset)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          testClockOffset: testClockOffsetPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      await methods
        .setTestClockOffset(offset)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          testClockOffset: testClockOffsetPda,
        })
        .rpc();
    }

    return testClockOffsetPda;
  }

  async function readTokenAmount(address: PublicKey): Promise<bigint> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const balance = await connection.getTokenAccountBalance(address, "confirmed");
        return BigInt(balance.value.amount);
      } catch {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1_500));
        }
      }
    }
    return 0n;
  }

  async function advanceClockForFees(): Promise<void> {
    try {
      await warpForwardSlots(connection, 5_000);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }

  before(async () => {
    await ensurePlatformInitialized();
    await ensureBotAuthority();
    treasuryUsdcAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        guardUsdcMint,
        treasuryPda,
        true,
      )
    ).address;
  });

  after(async () => {
    await refundTrackedKeypairs(connection);
  });

  it("supports revolving draw/repay/close and standby fee distribution", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.2),
      airdropSol(connection, lender, 0.05),
    ]);

    const contractSeed = new anchor.BN(91_001);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("debt_contract"),
        borrower.publicKey.toBuffer(),
        u64ToLeBytes(contractSeed),
      ],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );
    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    const targetRaw = 1_000_000_000_000n;
    const drawRaw = 300_000_000_000n;
    const repayRaw = 100_000_000_000n;
    const collateralRaw = 1_000_000n;
    const targetAmount = toBn(targetRaw);
    const accts = await createContractAccounts(
      borrower,
      contractPda,
      targetRaw,
      collateralRaw,
    );

    await program.methods
      .createDebtContract(
        contractSeed,
        14,
        targetAmount,
        toBn(1_200),
        30,
        new anchor.BN(0),
        { committed: {} },
        new anchor.BN(0),
        0,
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        true,
        false,
        0,
        true,
        300,
        { manual: {} },
        { public: {} },
      )
      .accountsPartial(
        contractCreateAccounts(
          contractPda,
          operationsFundPda,
          borrower.publicKey,
          accts,
        ),
      )
      .signers([borrower])
      .rpc();

    const lenderUsdcAta = await setupLender(lender, targetRaw);
    const contractBeforeContribution =
      await program.account.debtContract.fetch(contractPda);
    assert.equal(
      contractBeforeContribution.loanMint.toBase58(),
      guardUsdcMint.toBase58(),
      "loan mint must match treasury USDC mint",
    );
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(
        contributeAccounts(
          contractPda,
          contributionPda,
          escrowPda,
          lender.publicKey,
          borrower.publicKey,
          lenderUsdcAta,
          accts.contractUsdcAta,
          accts.borrowerUsdcAta,
        ),
      )
      .signers([lender])
      .rpc();

    const contractAfterFunding = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfterFunding.status, "active");
    assert.equal(contractAfterFunding.isRevolving, true);
    assert.equal(contractAfterFunding.creditLimit.toString(), targetRaw.toString());
    assert.equal(contractAfterFunding.availableAmount.toString(), targetRaw.toString());
    assert.equal(contractAfterFunding.drawnAmount.toString(), "0");
    assert.equal(contractAfterFunding.revolvingClosed, false);

    await program.methods
      .drawFromRevolving(toBn(drawRaw))
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
        contractUsdcAccount: accts.contractUsdcAta,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: contributionPda, isSigner: false, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: false },
      ])
      .signers([borrower])
      .rpc();

    const contractAfterDraw = await program.account.debtContract.fetch(contractPda);
    assert.equal(contractAfterDraw.drawnAmount.toString(), drawRaw.toString());
    assert.equal(
      contractAfterDraw.availableAmount.toString(),
      (targetRaw - drawRaw).toString(),
    );
    assert.equal(contractAfterDraw.outstandingBalance.toString(), drawRaw.toString());

    await program.methods
      .repayRevolving(toBn(repayRaw))
      .accounts({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
        contractUsdcAccount: accts.contractUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: contributionPda, isSigner: false, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: false },
      ])
      .signers([borrower])
      .rpc();

    const contractAfterRepay = await program.account.debtContract.fetch(contractPda);
    const expectedDrawnAfterRepay = drawRaw - repayRaw;
    assert.equal(
      contractAfterRepay.drawnAmount.toString(),
      expectedDrawnAfterRepay.toString(),
    );
    assert.equal(
      contractAfterRepay.availableAmount.toString(),
      (targetRaw - expectedDrawnAfterRepay).toString(),
    );

    const escrowUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardUsdcMint,
      escrowPda,
      true,
    );
    await advanceClockForFees();
    const escrowBefore = await program.account.lenderEscrow.fetch(escrowPda);
    const contractBeforeStandby = await program.account.debtContract.fetch(
      contractPda,
    );

    await (program as any).methods
      .distributeStandbyFees()
      .accounts({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        botAuthority: provider.wallet.publicKey,
        contractUsdcAccount: accts.contractUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: contributionPda, isSigner: false, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: escrowUsdcAta.address, isSigner: false, isWritable: true },
      ])
      .rpc();

    const escrowAfter = await program.account.lenderEscrow.fetch(escrowPda);
    const contractAfterStandby = await program.account.debtContract.fetch(
      contractPda,
    );
    assert.isTrue(
      contractAfterStandby.totalStandbyFeesPaid.gte(
        contractBeforeStandby.totalStandbyFeesPaid,
      ),
      "standby fee total should be monotonic",
    );
    assert.equal(contractAfterStandby.accruedStandbyFees.toString(), "0");
    assert.isTrue(
      escrowAfter.availableInterest.gte(escrowBefore.availableInterest),
      "escrow interest should not decrease",
    );

    await program.methods
      .closeRevolvingFacility()
      .accounts({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
        contractUsdcAccount: accts.contractUsdcAta,
        treasuryUsdcAccount: treasuryUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([borrower])
      .rpc();

    const contractAfterClose = await program.account.debtContract.fetch(contractPda);
    assert.equal(contractAfterClose.revolvingClosed, true);
    assert.equal(contractAfterClose.availableAmount.toString(), "0");

    try {
      await program.methods
        .drawFromRevolving(new anchor.BN(1))
        .accountsPartial({
          contract: contractPda,
          state: statePda,
          testClockOffset: null,
          treasury: treasuryPda,
          borrower: borrower.publicKey,
          borrowerUsdcAccount: accts.borrowerUsdcAta,
          contractUsdcAccount: accts.contractUsdcAta,
          collateralRegistry: collateralRegistryPda,
          priceFeedAccount: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([borrower])
        .rpc();
      assert.fail("expected draw_from_revolving to fail when facility is closed");
    } catch (error) {
      assert.match(
        extractAnchorErrorMessage(error),
        /RevolvingFacilityClosed|DrawExceedsAvailable/,
      );
    }

    const remainingDrawn = BigInt(contractAfterClose.drawnAmount.toString());
    if (remainingDrawn > 0n) {
      await program.methods
        .repayRevolving(toBn(remainingDrawn))
        .accounts({
          contract: contractPda,
          state: statePda,
          testClockOffset: null,
          treasury: treasuryPda,
          borrower: borrower.publicKey,
          borrowerUsdcAccount: accts.borrowerUsdcAta,
          contractUsdcAccount: accts.contractUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: contributionPda, isSigner: false, isWritable: false },
          { pubkey: escrowPda, isSigner: false, isWritable: false },
        ])
        .signers([borrower])
        .rpc();
    }

    const contractAfterFinalRepay = await program.account.debtContract.fetch(
      contractPda,
    );
    assert.equal(contractAfterFinalRepay.drawnAmount.toString(), "0");
    assert.equal(contractAfterFinalRepay.availableAmount.toString(), "0");
  });

  it("supports demand recall repayment on a partially drawn revolving facility", async function () {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.2),
      airdropSol(connection, lender, 0.05),
    ]);

    const contractSeed = new anchor.BN(91_004);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("debt_contract"),
        borrower.publicKey.toBuffer(),
        u64ToLeBytes(contractSeed),
      ],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );
    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    const targetRaw = 1_000_000_000n;
    const drawRaw = 300_000_000n;
    const collateralRaw = 50_000_000_000n;
    const targetAmount = toBn(targetRaw);
    const accts = await createContractAccounts(
      borrower,
      contractPda,
      targetRaw,
      collateralRaw,
    );

    const recallOracleSeed = nextOracleSeed();
    const recallOracleFeed = await upsertMockOraclePrice(recallOracleSeed, 250_000_000_000n);
    await (program as any).methods
      .updateCollateralType(guardCollateralMint, recallOracleFeed, null, null)
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        collateralRegistry: collateralRegistryPda,
        collateralMint: guardCollateralMint,
        oraclePriceFeed: recallOracleFeed,
      })
      .rpc();

    await program.methods
      .createDebtContract(
        contractSeed,
        14,
        targetAmount,
        toBn(1_200),
        0,
        toBn(collateralRaw),
        { demand: {} },
        4_000_000_000,
        11_000,
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        true,
        false,
        0,
        true,
        300,
        { manual: {} },
        { public: {} },
      )
      .accountsPartial(
        contractCreateAccounts(
          contractPda,
          operationsFundPda,
          borrower.publicKey,
          accts,
          recallOracleFeed,
        ),
      )
      .signers([borrower])
      .rpc();

    const lenderUsdcAta = await setupLender(lender, targetRaw);
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(
        contributeAccounts(
          contractPda,
          contributionPda,
          escrowPda,
          lender.publicKey,
          borrower.publicKey,
          lenderUsdcAta,
          accts.contractUsdcAta,
          accts.borrowerUsdcAta,
        ),
      )
      .signers([lender])
      .rpc();

    await program.methods
      .drawFromRevolving(toBn(drawRaw))
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
        contractUsdcAccount: accts.contractUsdcAta,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: recallOracleFeed,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: contributionPda, isSigner: false, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: false },
      ])
      .signers([borrower])
      .rpc();

    await program.methods
      .requestRecall()
      .accounts({
        contract: contractPda,
        state: statePda,
        lender: lender.publicKey,
        contribution: contributionPda,
      })
      .signers([lender])
      .rpc();

    // Borrower drew 300M but must repay the full 1B contribution amount.
    // Mint the shortfall so the borrower can cover the recall.
    const shortfall = targetRaw - drawRaw;
    await mintTo(
      connection,
      payer,
      guardUsdcMint,
      accts.borrowerUsdcAta,
      payer,
      shortfall,
    );

    const escrowUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardUsdcMint,
      escrowPda,
      true,
    );
    const borrowerUsdcBeforeRepay = await readTokenAmount(accts.borrowerUsdcAta);
    const escrowUsdcBeforeRepay = await readTokenAmount(escrowUsdcAta.address);

    await program.methods
      .borrowerRepayRecall()
      .accounts({
        contract: contractPda,
        borrower: borrower.publicKey,
        contribution: contributionPda,
        escrow: escrowPda,
        borrowerUsdcAta: accts.borrowerUsdcAta,
        escrowUsdcAta: escrowUsdcAta.address,
        contractCollateralAta: accts.contractCollateralAta,
        borrowerCollateralAta: accts.borrowerCollateralAta,
        state: statePda,
        testClockOffset: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([borrower])
      .rpc();

    await new Promise((r) => setTimeout(r, 2_000));
    const borrowerUsdcAfterRepay = await readTokenAmount(accts.borrowerUsdcAta);
    const escrowUsdcAfterRepay = await readTokenAmount(escrowUsdcAta.address);
    const contractAfterRepayRecall = await program.account.debtContract.fetch(contractPda);
    const contributionAfterRepayRecall = await program.account.lenderContribution.fetch(
      contributionPda,
    );

    expectAnchorEnumVariant(contractAfterRepayRecall.status, "completed");
    assert.equal(contractAfterRepayRecall.revolvingClosed, true);
    assert.equal(contractAfterRepayRecall.outstandingBalance.toString(), "0");
    assert.equal(contractAfterRepayRecall.drawnAmount.toString(), "0");
    assert.equal(contractAfterRepayRecall.fundedAmount.toString(), "0");
    assert.equal(contractAfterRepayRecall.creditLimit.toString(), "0");
    assert.equal(contractAfterRepayRecall.availableAmount.toString(), "0");
    assert.equal(contributionAfterRepayRecall.isRefunded, true);
    assert.isAbove(
      Number(borrowerUsdcBeforeRepay - borrowerUsdcAfterRepay),
      0,
      "borrower USDC balance decreased after recall repayment",
    );
    assert.equal(
      (escrowUsdcAfterRepay - escrowUsdcBeforeRepay).toString(),
      targetRaw.toString(),
      "recalled lender escrow receives recalled principal",
    );
  });

  it("enforces reduced availability after standby fee distribution", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.2),
      airdropSol(connection, lender, 0.05),
    ]);

    const contractSeed = new anchor.BN(91_003);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("debt_contract"),
        borrower.publicKey.toBuffer(),
        u64ToLeBytes(contractSeed),
      ],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );
    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    const targetRaw = 1_000_000_000_000n;
    const firstDrawRaw = 300_000_000_000n;
    const collateralRaw = 1_000_000n;
    const targetAmount = toBn(targetRaw);
    const accts = await createContractAccounts(
      borrower,
      contractPda,
      targetRaw,
      collateralRaw,
    );

    await program.methods
      .createDebtContract(
        contractSeed,
        14,
        targetAmount,
        toBn(1_200),
        30,
        new anchor.BN(0),
        { committed: {} },
        new anchor.BN(0),
        0,
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        true,
        false,
        0,
        true,
        300,
        { manual: {} },
        { public: {} },
      )
      .accountsPartial(
        contractCreateAccounts(
          contractPda,
          operationsFundPda,
          borrower.publicKey,
          accts,
        ),
      )
      .signers([borrower])
      .rpc();

    const lenderUsdcAta = await setupLender(lender, targetRaw);
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(
        contributeAccounts(
          contractPda,
          contributionPda,
          escrowPda,
          lender.publicKey,
          borrower.publicKey,
          lenderUsdcAta,
          accts.contractUsdcAta,
          accts.borrowerUsdcAta,
        ),
      )
      .signers([lender])
      .rpc();

    await program.methods
      .drawFromRevolving(toBn(firstDrawRaw))
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
        contractUsdcAccount: accts.contractUsdcAta,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: contributionPda, isSigner: false, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: false },
      ])
      .signers([borrower])
      .rpc();

    const escrowUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardUsdcMint,
      escrowPda,
      true,
    );
    await advanceClockForFees();

    await (program as any).methods
      .distributeStandbyFees()
      .accounts({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        botAuthority: provider.wallet.publicKey,
        contractUsdcAccount: accts.contractUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: contributionPda, isSigner: false, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: escrowUsdcAta.address, isSigner: false, isWritable: true },
      ])
      .rpc();

    const contractAfterStandby = await program.account.debtContract.fetch(contractPda);
    const availableAfterStandby = BigInt(
      contractAfterStandby.availableAmount.toString(),
    );
    const availableByLimit = BigInt(contractAfterStandby.creditLimit.toString()) -
      BigInt(contractAfterStandby.drawnAmount.toString());
    assert.isTrue(
      availableAfterStandby < availableByLimit,
      "standby fee distribution should reduce drawable capacity",
    );
    assert.isTrue(availableAfterStandby > 1n, "reduced availability should stay positive");

    const secondDrawRaw = availableAfterStandby / 2n;
    await program.methods
      .drawFromRevolving(toBn(secondDrawRaw))
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
        contractUsdcAccount: accts.contractUsdcAta,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: contributionPda, isSigner: false, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: false },
      ])
      .signers([borrower])
      .rpc();

    const contractAfterSecondDraw = await program.account.debtContract.fetch(contractPda);
    const availableAfterSecondDraw = BigInt(
      contractAfterSecondDraw.availableAmount.toString(),
    );
    assert.equal(
      contractAfterSecondDraw.drawnAmount.toString(),
      (firstDrawRaw + secondDrawRaw).toString(),
    );
    assert.isTrue(
      availableAfterSecondDraw <= availableAfterStandby - secondDrawRaw,
      `post-draw availability should include the draw and any standby accrual (before=${availableAfterStandby.toString()}, draw=${secondDrawRaw.toString()}, after=${availableAfterSecondDraw.toString()})`,
    );
    assert.isTrue(
      availableAfterSecondDraw < availableAfterStandby,
      "availability should decrease after the second draw",
    );

    const overdrawAmount = availableAfterSecondDraw + 1n;
    try {
      await program.methods
        .drawFromRevolving(toBn(overdrawAmount))
        .accountsPartial({
          contract: contractPda,
          state: statePda,
          testClockOffset: null,
          treasury: treasuryPda,
          borrower: borrower.publicKey,
          borrowerUsdcAccount: accts.borrowerUsdcAta,
          contractUsdcAccount: accts.contractUsdcAta,
          collateralRegistry: collateralRegistryPda,
          priceFeedAccount: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: contributionPda, isSigner: false, isWritable: false },
          { pubkey: escrowPda, isSigner: false, isWritable: false },
        ])
        .signers([borrower])
        .rpc();
      assert.fail("expected overdraw to fail with DrawExceedsAvailable");
    } catch (error) {
      assert.match(extractAnchorErrorMessage(error), /DrawExceedsAvailable/);
    }
  });

  it("distributes standby fees proportionally for multi-lender revolving facilities", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lenderA = anchor.web3.Keypair.generate();
    const lenderB = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.2),
      airdropSol(connection, lenderA, 0.05),
      airdropSol(connection, lenderB, 0.05),
    ]);

    const contractSeed = new anchor.BN(91_005);
    const { contractPda, operationsFundPda } = deriveContractPdas(
      borrower.publicKey,
      contractSeed,
    );
    const { contributionPda: contributionAPda, escrowPda: escrowAPda } =
      deriveContributionAndEscrowPdas(contractPda, lenderA.publicKey);
    const { contributionPda: contributionBPda, escrowPda: escrowBPda } =
      deriveContributionAndEscrowPdas(contractPda, lenderB.publicKey);

    const targetRaw = 1_000_000_000_000n;
    const lenderAContribution = 600_000_000_000n;
    const lenderBContribution = 400_000_000_000n;
    const drawRaw = 250_000_000_000n;
    const collateralRaw = 1_000_000n;
    const targetAmount = toBn(targetRaw);

    const accts = await createContractAccounts(
      borrower,
      contractPda,
      targetRaw,
      collateralRaw,
    );

    await program.methods
      .createDebtContract(
        contractSeed,
        14,
        targetAmount,
        toBn(1_200),
        30,
        new anchor.BN(0),
        { committed: {} },
        new anchor.BN(0),
        0,
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        true,
        false,
        0,
        true,
        300,
        { manual: {} },
        { public: {} },
      )
      .accountsPartial(
        contractCreateAccounts(
          contractPda,
          operationsFundPda,
          borrower.publicKey,
          accts,
        ),
      )
      .signers([borrower])
      .rpc();

    const [lenderAUsdcAta, lenderBUsdcAta] = await Promise.all([
      setupLender(lenderA, lenderAContribution),
      setupLender(lenderB, lenderBContribution),
    ]);

    await program.methods
      .contributeToContract(toBn(lenderAContribution))
      .accountsPartial(
        contributeAccounts(
          contractPda,
          contributionAPda,
          escrowAPda,
          lenderA.publicKey,
          borrower.publicKey,
          lenderAUsdcAta,
          accts.contractUsdcAta,
          accts.borrowerUsdcAta,
        ),
      )
      .signers([lenderA])
      .rpc();

    await program.methods
      .contributeToContract(toBn(lenderBContribution))
      .accountsPartial(
        contributeAccounts(
          contractPda,
          contributionBPda,
          escrowBPda,
          lenderB.publicKey,
          borrower.publicKey,
          lenderBUsdcAta,
          accts.contractUsdcAta,
          accts.borrowerUsdcAta,
        ),
      )
      .signers([lenderB])
      .rpc();

    await program.methods
      .drawFromRevolving(toBn(drawRaw))
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
        contractUsdcAccount: accts.contractUsdcAta,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(
        revolvingContributionPairsRemainingAccounts([
          { contributionPda: contributionAPda, escrowPda: escrowAPda },
          { contributionPda: contributionBPda, escrowPda: escrowBPda },
        ]),
      )
      .signers([borrower])
      .rpc();

    const [escrowAUsdcAta, escrowBUsdcAta] = await Promise.all([
      getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        guardUsdcMint,
        escrowAPda,
        true,
      ),
      getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        guardUsdcMint,
        escrowBPda,
        true,
      ),
    ]);

    await advanceClockForFees();
    const contractBeforeStandby = await program.account.debtContract.fetch(contractPda);
    const escrowABefore = await program.account.lenderEscrow.fetch(escrowAPda);
    const escrowBBefore = await program.account.lenderEscrow.fetch(escrowBPda);
    await Promise.all([
      readTokenAmount(escrowAUsdcAta.address),
      readTokenAmount(escrowBUsdcAta.address),
    ]);

    const standbyFeeAmount = BigInt(contractBeforeStandby.accruedStandbyFees.toString());

    await (program as any).methods
      .distributeStandbyFees()
      .accounts({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        botAuthority: provider.wallet.publicKey,
        contractUsdcAccount: accts.contractUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(
        standbyDistributionRemainingAccounts([
          {
            contributionPda: contributionAPda,
            escrowPda: escrowAPda,
            escrowUsdcAta: escrowAUsdcAta.address,
          },
          {
            contributionPda: contributionBPda,
            escrowPda: escrowBPda,
            escrowUsdcAta: escrowBUsdcAta.address,
          },
        ]),
      )
      .rpc();

    const contractAfterStandby = await program.account.debtContract.fetch(contractPda);
    const escrowAAfter = await program.account.lenderEscrow.fetch(escrowAPda);
    const escrowBAfter = await program.account.lenderEscrow.fetch(escrowBPda);
    await Promise.all([
      readTokenAmount(escrowAUsdcAta.address),
      readTokenAmount(escrowBUsdcAta.address),
    ]);

    const escrowAInterestDelta =
      BigInt(escrowAAfter.availableInterest.toString()) -
      BigInt(escrowABefore.availableInterest.toString());
    const escrowBInterestDelta =
      BigInt(escrowBAfter.availableInterest.toString()) -
      BigInt(escrowBBefore.availableInterest.toString());
    const totalDistributed = escrowAInterestDelta + escrowBInterestDelta;
    const expectedA =
      (totalDistributed * lenderAContribution) /
      (lenderAContribution + lenderBContribution);
    const expectedB = totalDistributed - expectedA;

    assert.equal(
      escrowAInterestDelta.toString(),
      expectedA.toString(),
      "lender A standby share should match contribution-weighted split",
    );
    assert.equal(
      escrowBInterestDelta.toString(),
      expectedB.toString(),
      "lender B standby share should match contribution-weighted split",
    );
    assert.equal(contractAfterStandby.accruedStandbyFees.toString(), "0");
  });

  it("rejects revolving draws when LTV safety checks fail", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.2),
      airdropSol(connection, lender, 0.05),
    ]);

    const contractSeed = new anchor.BN(91_006);
    const { contractPda, operationsFundPda } = deriveContractPdas(
      borrower.publicKey,
      contractSeed,
    );
    const { contributionPda, escrowPda } = deriveContributionAndEscrowPdas(
      contractPda,
      lender.publicKey,
    );

    const targetRaw = 1_000_000_000n;
    const firstDrawRaw = 400_000_000n;
    const secondDrawRaw = 100_000_000n;
    const collateralRaw = 100_000_000n;
    const targetAmount = toBn(targetRaw);
    const accts = await createContractAccounts(
      borrower,
      contractPda,
      targetRaw,
      collateralRaw,
    );

    const ltvOracleSeed = nextOracleSeed();
    const ltvOracleFeed = await upsertMockOraclePrice(ltvOracleSeed, 250_000_000_000n);
    await (program as any).methods
      .updateCollateralType(guardCollateralMint, ltvOracleFeed, null, null)
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        collateralRegistry: collateralRegistryPda,
        collateralMint: guardCollateralMint,
        oraclePriceFeed: ltvOracleFeed,
      })
      .rpc();

    await program.methods
      .createDebtContract(
        contractSeed,
        14,
        targetAmount,
        toBn(1_200),
        14,
        toBn(collateralRaw),
        { committed: {} },
        20_000,
        11_000,
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        true,
        false,
        0,
        true,
        300,
        { manual: {} },
        { public: {} },
      )
      .accountsPartial(
        contractCreateAccounts(
          contractPda,
          operationsFundPda,
          borrower.publicKey,
          accts,
          ltvOracleFeed,
        ),
      )
      .signers([borrower])
      .rpc();

    const lenderUsdcAta = await setupLender(lender, targetRaw);
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(
        contributeAccounts(
          contractPda,
          contributionPda,
          escrowPda,
          lender.publicKey,
          borrower.publicKey,
          lenderUsdcAta,
          accts.contractUsdcAta,
          accts.borrowerUsdcAta,
        ),
      )
      .signers([lender])
      .rpc();

    await upsertMockOraclePrice(ltvOracleSeed, 100_000n);

    await program.methods
      .drawFromRevolving(toBn(firstDrawRaw))
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
        contractUsdcAccount: accts.contractUsdcAta,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: ltvOracleFeed,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(
        revolvingContributionPairsRemainingAccounts([
          { contributionPda, escrowPda },
        ]),
      )
      .signers([borrower])
      .rpc();

    await upsertMockOraclePrice(ltvOracleSeed, 500_000_000_000n);

    try {
      await program.methods
        .drawFromRevolving(toBn(secondDrawRaw))
        .accountsPartial({
          contract: contractPda,
          state: statePda,
          testClockOffset: null,
          treasury: treasuryPda,
          borrower: borrower.publicKey,
          borrowerUsdcAccount: accts.borrowerUsdcAta,
          contractUsdcAccount: accts.contractUsdcAta,
          collateralRegistry: collateralRegistryPda,
          priceFeedAccount: ltvOracleFeed,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(
          revolvingContributionPairsRemainingAccounts([
            { contributionPda, escrowPda },
          ]),
        )
        .signers([borrower])
        .rpc();
      assert.fail("expected second draw to fail with RevolvingLtvBreach");
    } catch (error) {
      assert.match(extractAnchorErrorMessage(error), /RevolvingLtvBreach/);
    }
  });

  it("applies early termination standby fee when closing a committed revolving facility", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.2),
      airdropSol(connection, lender, 0.05),
    ]);

    const contractSeed = new anchor.BN(91_007);
    const { contractPda, operationsFundPda } = deriveContractPdas(
      borrower.publicKey,
      contractSeed,
    );
    const { contributionPda, escrowPda } = deriveContributionAndEscrowPdas(
      contractPda,
      lender.publicKey,
    );

    const targetRaw = 1_000_000_000_000n;
    const drawRaw = 250_000_000_000n;
    const collateralRaw = 1_000_000n;
    const targetAmount = toBn(targetRaw);
    const accts = await createContractAccounts(
      borrower,
      contractPda,
      targetRaw,
      collateralRaw,
    );

    await program.methods
      .createDebtContract(
        contractSeed,
        14,
        targetAmount,
        toBn(1_200),
        30,
        new anchor.BN(0),
        { committed: {} },
        new anchor.BN(0),
        0,
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        true,
        false,
        0,
        true,
        300,
        { manual: {} },
        { public: {} },
      )
      .accountsPartial(
        contractCreateAccounts(
          contractPda,
          operationsFundPda,
          borrower.publicKey,
          accts,
        ),
      )
      .signers([borrower])
      .rpc();

    const lenderUsdcAta = await setupLender(lender, targetRaw);
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(
        contributeAccounts(
          contractPda,
          contributionPda,
          escrowPda,
          lender.publicKey,
          borrower.publicKey,
          lenderUsdcAta,
          accts.contractUsdcAta,
          accts.borrowerUsdcAta,
        ),
      )
      .signers([lender])
      .rpc();

    await program.methods
      .drawFromRevolving(toBn(drawRaw))
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
        contractUsdcAccount: accts.contractUsdcAta,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(
        revolvingContributionPairsRemainingAccounts([{ contributionPda, escrowPda }]),
      )
      .signers([borrower])
      .rpc();

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const contractBeforeClose = await program.account.debtContract.fetch(contractPda);
    const [borrowerUsdcBeforeClose, contractUsdcBeforeClose] = await Promise.all([
      readTokenAmount(accts.borrowerUsdcAta),
      readTokenAmount(accts.contractUsdcAta),
    ]);

    await program.methods
      .closeRevolvingFacility()
      .accounts({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
        contractUsdcAccount: accts.contractUsdcAta,
        treasuryUsdcAccount: treasuryUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([borrower])
      .rpc();

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const contractAfterClose = await program.account.debtContract.fetch(contractPda);
    const [borrowerUsdcAfterClose, contractUsdcAfterClose] = await Promise.all([
      readTokenAmount(accts.borrowerUsdcAta),
      readTokenAmount(accts.contractUsdcAta),
    ]);

    const closeTimestamp = BigInt(contractAfterClose.lastBotUpdate.toString());
    const createdAt = BigInt(contractBeforeClose.createdAt.toString());
    const termDays = BigInt(contractBeforeClose.termDays.toString());
    const maturityTimestamp = createdAt + termDays * 24n * 60n * 60n;
    const remainingSeconds =
      maturityTimestamp > closeTimestamp ? maturityTimestamp - closeTimestamp : 0n;
    const availableBeforeClose = BigInt(
      contractBeforeClose.availableAmount.toString(),
    );
    const standbyFeeRate = BigInt(contractBeforeClose.standbyFeeRate.toString());
    const elapsedForCheckpointRaw =
      closeTimestamp - BigInt(contractBeforeClose.lastStandbyFeeUpdate.toString());
    const elapsedForCheckpoint = elapsedForCheckpointRaw > 0n ? elapsedForCheckpointRaw : 0n;

    const expectedCheckpointFee = calculateStandbyFeeRaw(
      availableBeforeClose,
      standbyFeeRate,
      elapsedForCheckpoint,
    );
    const expectedEarlyTerminationFee = calculateStandbyFeeRaw(
      availableBeforeClose,
      standbyFeeRate,
      remainingSeconds,
    );
    const expectedTotalAccrual = expectedCheckpointFee + expectedEarlyTerminationFee;

    const accruedBeforeClose = BigInt(
      contractBeforeClose.accruedStandbyFees.toString(),
    );
    const accruedAfterClose = BigInt(
      contractAfterClose.accruedStandbyFees.toString(),
    );
    const accruedDelta = accruedAfterClose - accruedBeforeClose;

    assert.isTrue(
      expectedEarlyTerminationFee > 0n,
      "early termination fee should be positive when closing before maturity",
    );
    assert.equal(
      accruedDelta.toString(),
      expectedTotalAccrual.toString(),
      "close should add checkpoint accrual plus early termination fee to accrued standby fees",
    );

    const borrowerPaid = borrowerUsdcBeforeClose - borrowerUsdcAfterClose;
    const contractReceived = contractUsdcAfterClose - contractUsdcBeforeClose;
    assert.isTrue(
      borrowerPaid >= expectedEarlyTerminationFee,
      "borrower USDC should decrease by at least the early termination fee",
    );
    assert.isTrue(
      contractReceived >= expectedEarlyTerminationFee,
      "contract USDC should increase by at least the early termination fee",
    );
    assert.equal(contractAfterClose.revolvingClosed, true);
    assert.equal(contractAfterClose.availableAmount.toString(), "0");
  });

  it("applies revolving state reductions on partial liquidation", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.2),
      airdropSol(connection, lender, 0.05),
    ]);

    const contractSeed = new anchor.BN(91_008);
    const { contractPda, operationsFundPda } = deriveContractPdas(
      borrower.publicKey,
      contractSeed,
    );
    const { contributionPda, escrowPda } = deriveContributionAndEscrowPdas(
      contractPda,
      lender.publicKey,
    );

    const targetRaw = 1_000_000_000n;
    const drawRaw = 600_000_000n;
    const requestedRepay = 350_000_000n;
    const collateralRaw = 50_000_000_000n;
    const targetAmount = toBn(targetRaw);
    const accts = await createContractAccounts(
      borrower,
      contractPda,
      targetRaw,
      collateralRaw,
    );

    const liquidationOracleSeed = nextOracleSeed();
    const liquidationOracleFeed = await upsertMockOraclePrice(
      liquidationOracleSeed,
      250_000_000_000n,
    );
    await (program as any).methods
      .updateCollateralType(guardCollateralMint, liquidationOracleFeed, null, null)
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        collateralRegistry: collateralRegistryPda,
        collateralMint: guardCollateralMint,
        oraclePriceFeed: liquidationOracleFeed,
      })
      .rpc();

    await program.methods
      .createDebtContract(
        contractSeed,
        14,
        targetAmount,
        toBn(1_200),
        14,
        toBn(collateralRaw),
        { committed: {} },
        4_000_000_000,
        11_000,
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        true,
        false,
        0,
        true,
        300,
        { manual: {} },
        { public: {} },
      )
      .accountsPartial(
        contractCreateAccounts(
          contractPda,
          operationsFundPda,
          borrower.publicKey,
          accts,
          liquidationOracleFeed,
        ),
      )
      .signers([borrower])
      .rpc();

    const lenderUsdcAta = await setupLender(lender, targetRaw);
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(
        contributeAccounts(
          contractPda,
          contributionPda,
          escrowPda,
          lender.publicKey,
          borrower.publicKey,
          lenderUsdcAta,
          accts.contractUsdcAta,
          accts.borrowerUsdcAta,
        ),
      )
      .signers([lender])
      .rpc();

    await program.methods
      .drawFromRevolving(toBn(drawRaw))
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
        contractUsdcAccount: accts.contractUsdcAta,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: liquidationOracleFeed,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(
        revolvingContributionPairsRemainingAccounts([{ contributionPda, escrowPda }]),
      )
      .signers([borrower])
      .rpc();

    await upsertMockOraclePrice(liquidationOracleSeed, 5_000_000n);

    const botUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardUsdcMint,
      provider.wallet.publicKey,
    );
    const botCollateralAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardCollateralMint,
      provider.wallet.publicKey,
    );
    await mintTo(
      connection,
      payer,
      guardUsdcMint,
      botUsdcAta.address,
      provider.wallet.publicKey,
      requestedRepay + 1_000_000_000n,
    );

    const escrowUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardUsdcMint,
      escrowPda,
      true,
    );

    const contractBeforePartial = await program.account.debtContract.fetch(contractPda);
    await (program as any).methods
      .partialLiquidate(toBn(requestedRepay))
      .accounts({
        contract: contractPda,
        state: statePda,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: liquidationOracleFeed,
        botUsdcAta: botUsdcAta.address,
        contractUsdcAta: accts.contractUsdcAta,
        contractCollateralAta: accts.contractCollateralAta,
        botCollateralAta: botCollateralAta.address,
        treasury: treasuryPda,
        botAuthority: provider.wallet.publicKey,
        borrower: borrower.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(
        liquidationDistributionRemainingAccounts([
          {
            contributionPda,
            escrowPda,
            escrowUsdcAta: escrowUsdcAta.address,
          },
        ]),
      )
      .rpc();

    const contractAfterPartial = await program.account.debtContract.fetch(contractPda);

    const drawnBefore = BigInt(contractBeforePartial.drawnAmount.toString());
    const creditBefore = BigInt(contractBeforePartial.creditLimit.toString());
    const drawnAfter = BigInt(contractAfterPartial.drawnAmount.toString());
    const creditAfter = BigInt(contractAfterPartial.creditLimit.toString());
    const availableAfter = BigInt(contractAfterPartial.availableAmount.toString());
    const drawnReduction = drawnBefore - drawnAfter;
    const creditReduction = creditBefore - creditAfter;

    assert.isTrue(drawnReduction > 0n, "partial liquidation must reduce drawn amount");
    assert.isTrue(
      drawnReduction <= requestedRepay,
      "partial liquidation should not reduce more than requested repay amount",
    );
    assert.equal(
      drawnReduction.toString(),
      creditReduction.toString(),
      "drawn amount and credit limit should be reduced by the same liquidated amount",
    );
    assert.equal(
      availableAfter.toString(),
      (creditAfter - drawnAfter).toString(),
      "available amount should remain credit_limit - drawn_amount after liquidation",
    );
    assert.equal(
      contractAfterPartial.outstandingBalance.toString(),
      contractAfterPartial.drawnAmount.toString(),
      "revolving outstanding balance should track drawn amount after partial liquidation",
    );
  });

  it("rejects additional revolving draws once maturity is reached", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.2),
      airdropSol(connection, lender, 0.05),
    ]);

    const contractSeed = new anchor.BN(91_009);
    const { contractPda, operationsFundPda } = deriveContractPdas(
      borrower.publicKey,
      contractSeed,
    );
    const { contributionPda, escrowPda } = deriveContributionAndEscrowPdas(
      contractPda,
      lender.publicKey,
    );

    const targetRaw = 1_000_000_000n;
    const firstDrawRaw = 100_000_000n;
    const secondDrawRaw = 50_000_000n;
    const collateralRaw = 1_000_000n;
    const targetAmount = toBn(targetRaw);
    const accts = await createContractAccounts(
      borrower,
      contractPda,
      targetRaw,
      collateralRaw,
    );

    await program.methods
      .createDebtContract(
        contractSeed,
        14,
        targetAmount,
        toBn(1_200),
        1,
        new anchor.BN(0),
        { committed: {} },
        new anchor.BN(0),
        0,
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        true,
        false,
        0,
        true,
        300,
        { manual: {} },
        { public: {} },
      )
      .accountsPartial(
        contractCreateAccounts(
          contractPda,
          operationsFundPda,
          borrower.publicKey,
          accts,
        ),
      )
      .signers([borrower])
      .rpc();

    const lenderUsdcAta = await setupLender(lender, targetRaw);
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(
        contributeAccounts(
          contractPda,
          contributionPda,
          escrowPda,
          lender.publicKey,
          borrower.publicKey,
          lenderUsdcAta,
          accts.contractUsdcAta,
          accts.borrowerUsdcAta,
        ),
      )
      .signers([lender])
      .rpc();

    await program.methods
      .drawFromRevolving(toBn(firstDrawRaw))
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        testClockOffset: null,
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
        contractUsdcAccount: accts.contractUsdcAta,
        collateralRegistry: collateralRegistryPda,
        priceFeedAccount: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(
        revolvingContributionPairsRemainingAccounts([{ contributionPda, escrowPda }]),
      )
      .signers([borrower])
      .rpc();

    let testClockOffsetAccount: PublicKey | null = null;
    try {
      testClockOffsetAccount = await setTestClockOffsetSeconds(2 * 24 * 60 * 60);
      if (testClockOffsetAccount === null) {
        await warpForwardSlots(connection, 260_000);
      }

      try {
        await program.methods
          .drawFromRevolving(toBn(secondDrawRaw))
          .accountsPartial({
            contract: contractPda,
            state: statePda,
            testClockOffset: testClockOffsetAccount,
            treasury: treasuryPda,
            borrower: borrower.publicKey,
            borrowerUsdcAccount: accts.borrowerUsdcAta,
            contractUsdcAccount: accts.contractUsdcAta,
            collateralRegistry: collateralRegistryPda,
            priceFeedAccount: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .remainingAccounts(
            revolvingContributionPairsRemainingAccounts([
              { contributionPda, escrowPda },
            ]),
          )
          .signers([borrower])
          .rpc();
        assert.fail("expected draw to fail after maturity");
      } catch (error) {
        assert.match(extractAnchorErrorMessage(error), /PastMaturity/);
      }
    } finally {
      if (testClockOffsetAccount !== null) {
        await setTestClockOffsetSeconds(0);
      }
    }
  });

  it("keeps standard disbursement behavior for non-revolving contracts", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.2),
      airdropSol(connection, lender, 0.05),
    ]);

    const contractSeed = new anchor.BN(91_002);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("debt_contract"),
        borrower.publicKey.toBuffer(),
        u64ToLeBytes(contractSeed),
      ],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );
    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    const targetRaw = 1_000_000_000n;
    const collateralRaw = 1_000_000n;
    const targetAmount = toBn(targetRaw);
    const accts = await createContractAccounts(
      borrower,
      contractPda,
      targetRaw,
      collateralRaw,
    );

    await program.methods
      .createDebtContract(
        contractSeed,
        14,
        targetAmount,
        toBn(600),
        30,
        new anchor.BN(0),
        { committed: {} },
        new anchor.BN(0),
        0,
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        true,
        false,
        0,
        false,
        0,
        { manual: {} },
        { public: {} },
      )
      .accountsPartial(
        contractCreateAccounts(
          contractPda,
          operationsFundPda,
          borrower.publicKey,
          accts,
        ),
      )
      .signers([borrower])
      .rpc();

    const lenderUsdcAta = await setupLender(lender, targetRaw);
    const contractBeforeContribution =
      await program.account.debtContract.fetch(contractPda);
    assert.equal(
      contractBeforeContribution.loanMint.toBase58(),
      guardUsdcMint.toBase58(),
      "loan mint must match treasury USDC mint",
    );
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(
        contributeAccounts(
          contractPda,
          contributionPda,
          escrowPda,
          lender.publicKey,
          borrower.publicKey,
          lenderUsdcAta,
          accts.contractUsdcAta,
          accts.borrowerUsdcAta,
        ),
      )
      .signers([lender])
      .rpc();

    const contractUsdcAfterFunding = await readTokenAmount(accts.contractUsdcAta);
    assert.equal(
      contractUsdcAfterFunding.toString(),
      "0",
      "non-revolving activation should disburse funded amount from contract custody",
    );

    const contractAfterFunding = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfterFunding.status, "active");
    assert.equal(contractAfterFunding.isRevolving, false);
    assert.equal(contractAfterFunding.creditLimit.toString(), "0");
    assert.equal(contractAfterFunding.availableAmount.toString(), "0");
    assert.equal(contractAfterFunding.outstandingBalance.toString(), targetRaw.toString());
  });
});
