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

  let guardUsdcMint: PublicKey;
  let guardCollateralMint: PublicKey;
  let treasuryUsdcAta: PublicKey;

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
    }

    guardCollateralMint = await createMint(
      connection,
      payer,
      provider.wallet.publicKey,
      null,
      8,
    );
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
      priceFeedAccount: SystemProgram.programId,
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

  async function readTokenAmount(address: PublicKey): Promise<bigint> {
    const balance = await connection.getTokenAccountBalance(address, "confirmed");
    return BigInt(balance.value.amount);
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
        treasury: treasuryPda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
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
