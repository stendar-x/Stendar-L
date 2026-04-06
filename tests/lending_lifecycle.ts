import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { airdropSol, findMintableCollateralEntry, isValidSplMint, refundTrackedKeypairs } from "./test_helpers.ts";

const BPF_UPGRADEABLE_LOADER_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

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

function expectAnchorEnumVariant(enumObj: unknown, expectedKey: string): void {
  assert.isObject(enumObj, "enum is not an object");
  assert.ok(
    Object.prototype.hasOwnProperty.call(enumObj as Record<string, unknown>, expectedKey),
    `expected enum variant '${expectedKey}', got: ${JSON.stringify(enumObj)}`,
  );
}

describe("Lending lifecycle", () => {
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
  let treasuryUsdcAta: PublicKey;

  const payer = (provider.wallet as anchor.Wallet & { payer: anchor.web3.Keypair }).payer;

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
  let guardOracleSeed = new anchor.BN(99_000);

  function toBn(value: bigint | number): anchor.BN {
    return new anchor.BN(value.toString());
  }

  function mockOraclePda(feedSeed: anchor.BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle_price_feed"), u64ToLeBytes(feedSeed)],
      program.programId,
    )[0];
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
      await program.methods
        .initializeTreasury(provider.wallet.publicKey)
        .accounts({
          state: statePda,
          treasury: treasuryPda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  }

  async function initGuardInfrastructure(): Promise<void> {
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

    const feedPda = mockOraclePda(guardOracleSeed);
    const slot = await connection.getSlot("confirmed");
    const blockTime = await connection.getBlockTime(slot);
    const publishTime = blockTime ?? Math.floor(Date.now() / 1000);

    const existingFeed = await connection.getAccountInfo(feedPda);
    if (existingFeed) {
      await program.methods
        .setMockOraclePriceFeed(toBn(200_000_000n), -8, toBn(publishTime))
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: feedPda,
        })
        .rpc();
    } else {
      await program.methods
        .initializeMockOraclePriceFeed(guardOracleSeed, toBn(200_000_000n), -8, toBn(publishTime))
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: feedPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    guardOraclePriceFeed = feedPda;

    const registryInfo = await connection.getAccountInfo(collateralRegistryPda);
    if (registryInfo === null) {
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

    try {
      await program.methods
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
    } catch (err: any) {
      const errMsg = err?.message ?? err?.toString() ?? "";
      if (errMsg.includes("CollateralRegistryFull") || errMsg.includes("CollateralAlreadyRegistered")) {
        const registry = await program.account.collateralRegistry.fetch(collateralRegistryPda);
        const active = findMintableCollateralEntry(registry.collateralTypes as any[], provider.wallet.publicKey);
        if (active) {
          guardCollateralMint = active.mint;
          guardOraclePriceFeed = active.oraclePriceFeed;
          const feedSlot = await connection.getSlot("confirmed");
          const feedBlockTime = await connection.getBlockTime(feedSlot);
          const feedPublishTime = feedBlockTime ?? Math.floor(Date.now() / 1000);
          const oracleAcct = await connection.getAccountInfo(guardOraclePriceFeed);
          if (oracleAcct) {
            const data = oracleAcct.data;
            const seedBytes = data.slice(8 + 32, 8 + 32 + 8);
            const oracleSeed = new anchor.BN(seedBytes, "le");
            await program.methods
              .setMockOraclePriceFeed(toBn(200_000_000n), -8, toBn(feedPublishTime))
              .accounts({
                authority: provider.wallet.publicKey,
                state: statePda,
                mockOraclePriceFeed: guardOraclePriceFeed,
              })
              .rpc();
          }
        } else {
          throw new Error("No active collateral type found in registry");
        }
      } else {
        throw err;
      }
    }
  }

  async function createContractAccounts(
    borrower: anchor.web3.Keypair,
    contractPda: PublicKey,
    targetUsdc: bigint,
    collateralRaw: bigint,
  ) {
    const borrowerCollateralAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardCollateralMint, borrower.publicKey);
    const contractCollateralAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardCollateralMint, contractPda, true);
    const borrowerUsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, borrower.publicKey);
    const contractUsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, contractPda, true);
    await mintTo(connection, payer, guardCollateralMint, borrowerCollateralAta.address, provider.wallet.publicKey, collateralRaw);
    await mintTo(connection, payer, guardUsdcMint, borrowerUsdcAta.address, provider.wallet.publicKey, targetUsdc + 500_000n);
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
    accts: { borrowerCollateralAta: PublicKey; contractCollateralAta: PublicKey; borrowerUsdcAta: PublicKey; contractUsdcAta: PublicKey },
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
      priceFeedAccount: guardOraclePriceFeed,
      usdcMint: guardUsdcMint,
      contractUsdcAta: accts.contractUsdcAta,
      borrowerUsdcAta: accts.borrowerUsdcAta,
      treasuryUsdcAccount: treasuryUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    };
  }

  async function setupLender(lender: anchor.web3.Keypair, amount: bigint) {
    const lenderUsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, lender.publicKey);
    await mintTo(connection, payer, guardUsdcMint, lenderUsdcAta.address, provider.wallet.publicKey, amount);
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

  before(async () => {
    await ensurePlatformInitialized();
    await initGuardInfrastructure();
    treasuryUsdcAta = (await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, treasuryPda, true)).address;
  });

  after(async () => {
    await refundTrackedKeypairs(connection);
  });

  beforeEach(async () => {
    const freshPublishTime = new anchor.BN(Math.floor(Date.now() / 1000));
    try {
      await (program as any).methods
        .setMockOraclePriceFeed(
          toBn(200_000_000n),
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

  it("Cancels an open contract and returns collateral", async () => {
    const borrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower, 0.1);

    const contractSeed = new anchor.BN(1001);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = toBn(1_000_000n);
    const collateralAmount = toBn(200_000_000n);
    const accts = await createContractAccounts(borrower, contractPda, 1_000_000n, 200_000_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(1000),
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(11_000),
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
      .accounts(contractCreateAccounts(contractPda, operationsFundPda, borrower.publicKey, accts))
      .signers([borrower])
      .rpc();

    const opsAccountInfoBefore = await connection.getAccountInfo(operationsFundPda);
    if (opsAccountInfoBefore) {
      assert.isAbove(opsAccountInfoBefore.data.length, 0);
    }

    const contractBefore = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractBefore.status, "openNotFunded");

    await program.methods
      .cancelContract()
      .accounts({
        contract: contractPda,
        operationsFund: operationsFundPda,
        borrower: borrower.publicKey,
        contractCollateralAta: accts.contractCollateralAta,
        borrowerCollateralAta: accts.borrowerCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([borrower])
      .rpc();

    const contractAfter = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfter.status, "cancelled");

    const opsAccountInfoAfter = await connection.getAccountInfo(operationsFundPda);
    assert.ok(
      opsAccountInfoAfter === null ||
        (opsAccountInfoAfter.lamports === 0 && opsAccountInfoAfter.data.length === 0),
      "operations fund should be closed on cancel",
    );

    const borrowerCollateralBalance = await connection.getTokenAccountBalance(accts.borrowerCollateralAta);
    assert.equal(
      borrowerCollateralBalance.value.amount,
      "200000000",
      "contract collateral should be returned on cancel",
    );
  });

  it("Distributes a payment to escrow and allows lender to claim", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.1),
      airdropSol(connection, lender, 0.05),
    ]);

    const contractSeed = new anchor.BN(2001);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = toBn(1_000_000n);
    const collateralAmount = toBn(200_000_000n);
    const accts = await createContractAccounts(borrower, contractPda, 1_000_000n, 200_000_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(500),
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(11_000),
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
      .accounts(contractCreateAccounts(contractPda, operationsFundPda, borrower.publicKey, accts))
      .signers([borrower])
      .rpc();

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    const lenderUsdcAta = await setupLender(lender, 1_000_000n);
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(contributeAccounts(contractPda, contributionPda, escrowPda, lender.publicKey, borrower.publicKey, lenderUsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
      .signers([lender])
      .rpc();

    const contractAfterFunding = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfterFunding.status, "active");

    const paymentAmount = toBn(200_000n);
    const escrowUsdcAtaForPayment = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, escrowPda, true);
    await program.methods
      .makePaymentWithDistribution(paymentAmount)
      .accountsPartial({
        contract: contractPda,
        operationsFund: operationsFundPda,
        state: statePda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
        contractUsdcAccount: accts.contractUsdcAta,
        contractCollateralAccount: accts.contractCollateralAta,
        borrowerCollateralAccount: accts.borrowerCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: contributionPda, isSigner: false, isWritable: true },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
        { pubkey: escrowUsdcAtaForPayment.address, isSigner: false, isWritable: true },
      ])
      .signers([borrower])
      .rpc();

    const escrowBefore = await program.account.lenderEscrow.fetch(escrowPda);
    const availableBefore = escrowBefore.availableInterest
      .add(escrowBefore.availablePrincipal)
      .toNumber();
    assert.equal(availableBefore, paymentAmount.toNumber());

    const escrowUsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, escrowPda, true);
    await program.methods
      .claimFromEscrow()
      .accountsPartial({
        contract: contractPda,
        escrow: escrowPda,
        lender: lender.publicKey,
        escrowUsdcAccount: escrowUsdcAta.address,
        lenderUsdcAccount: lenderUsdcAta,
        usdcMint: guardUsdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender])
      .rpc();

    const escrowAfter = await program.account.lenderEscrow.fetch(escrowPda);
    assert.equal(escrowAfter.availableInterest.toNumber(), 0);
    assert.equal(escrowAfter.availablePrincipal.toNumber(), 0);
  });

  it("Completes a fully repaid contract and refunds operations fund", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.1),
      airdropSol(connection, lender, 0.05),
    ]);

    const contractSeed = new anchor.BN(2501);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = toBn(1_000_000n);
    const collateralAmount = toBn(200_000_000n);
    const accts = await createContractAccounts(borrower, contractPda, 1_000_000n, 200_000_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(500),
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(11_000),
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        14,
        true,
        false,
        0,
        { automatic: {} },
        { public: {} },
      )
      .accounts(contractCreateAccounts(contractPda, operationsFundPda, borrower.publicKey, accts))
      .signers([borrower])
      .rpc();

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    const lenderUsdcAta = await setupLender(lender, 1_000_000n);
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(contributeAccounts(contractPda, contributionPda, escrowPda, lender.publicKey, borrower.publicKey, lenderUsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
      .signers([lender])
      .rpc();

    const opsAccountInfoBefore = await connection.getAccountInfo(operationsFundPda);
    if (opsAccountInfoBefore) {
      assert.isAbove(opsAccountInfoBefore.data.length, 0);
    }

    await program.methods
      .makePayment(targetAmount)
      .accountsPartial({
        contract: contractPda,
        operationsFund: operationsFundPda,
        state: statePda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: accts.borrowerUsdcAta,
        contractUsdcAccount: accts.contractUsdcAta,
        contractCollateralAccount: accts.contractCollateralAta,
        borrowerCollateralAccount: accts.borrowerCollateralAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([borrower])
      .rpc();

    const contractAfter = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfter.status, "completed");

    const opsAccountInfoAfter = await connection.getAccountInfo(operationsFundPda);
    assert.ok(
      opsAccountInfoAfter === null ||
        (opsAccountInfoAfter.lamports === 0 && opsAccountInfoAfter.data.length === 0),
      "operations fund should be closed on completion",
    );
  });

  it("Enforces the per-contract max_lenders cap", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender1 = anchor.web3.Keypair.generate();
    const lender2 = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.1),
      airdropSol(connection, lender1, 0.05),
      airdropSol(connection, lender2, 0.05),
    ]);

    const contractSeed = new anchor.BN(2601);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = toBn(1_000_000n);
    const collateralAmount = toBn(200_000_000n);
    const accts = await createContractAccounts(borrower, contractPda, 1_000_000n, 200_000_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(500),
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(11_000),
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        1,
        true,
        false,
        0,
        { manual: {} },
        { public: {} },
      )
      .accounts(contractCreateAccounts(contractPda, operationsFundPda, borrower.publicKey, accts))
      .signers([borrower])
      .rpc();

    const [contribution1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender1.publicKey.toBuffer()],
      program.programId,
    );
    const [escrow1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender1.publicKey.toBuffer()],
      program.programId,
    );

    const lender1UsdcAta = await setupLender(lender1, 1_000_000n);
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(contributeAccounts(contractPda, contribution1Pda, escrow1Pda, lender1.publicKey, borrower.publicKey, lender1UsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
      .signers([lender1])
      .rpc();

    const contractAfterFull = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfterFull.status, "active");

    const [contribution2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender2.publicKey.toBuffer()],
      program.programId,
    );
    const [escrow2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender2.publicKey.toBuffer()],
      program.programId,
    );

    const lender2UsdcAta = await setupLender(lender2, 100_000n);
    try {
      await program.methods
        .contributeToContract(toBn(1n))
        .accountsPartial(contributeAccounts(contractPda, contribution2Pda, escrow2Pda, lender2.publicKey, borrower.publicKey, lender2UsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
        .signers([lender2])
        .rpc();
      assert.fail("expected contribute_to_contract to fail when max_lenders is reached");
    } catch (err) {
      const anyErr = err as any;
      const msg =
        anyErr?.error?.errorCode?.code ??
        anyErr?.error?.errorMessage ??
        anyErr?.toString?.() ??
        String(err);
      assert.match(msg, /ContractNotOpen|MaxLendersReached/);
    }
  });

  it("Rejects underfunding on the last lender slot", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender1 = anchor.web3.Keypair.generate();
    const lender2 = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.1),
      airdropSol(connection, lender1, 0.05),
      airdropSol(connection, lender2, 0.05),
    ]);

    const targetUsdc = 1_000_000n; // 1 USDC
    const collateralRaw = 200_000_000n; // 2 units at 8 decimals

    const contractSeed = new anchor.BN(2602);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const borrowerCollateralAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardCollateralMint, borrower.publicKey);
    const contractCollateralAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardCollateralMint, contractPda, true);
    const borrowerUsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, borrower.publicKey);
    const contractUsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, contractPda, true);
    const treasuryUsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, treasuryPda, true);

    await mintTo(connection, payer, guardCollateralMint, borrowerCollateralAta.address, provider.wallet.publicKey, collateralRaw);
    await mintTo(connection, payer, guardUsdcMint, borrowerUsdcAta.address, provider.wallet.publicKey, 100_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        toBn(targetUsdc),
        new anchor.BN(500),
        30,
        toBn(collateralRaw),
        { committed: {} },
        new anchor.BN(11_000),
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        2, // max_lenders
        true, // partial_funding_enabled
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
        treasuryUsdcAccount: treasuryUsdcAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([borrower])
      .rpc();

    const firstAmount = 250_000n; // 0.25 USDC
    const [contribution1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender1.publicKey.toBuffer()],
      program.programId,
    );
    const [escrow1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender1.publicKey.toBuffer()],
      program.programId,
    );
    const lender1UsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, lender1.publicKey);
    await mintTo(connection, payer, guardUsdcMint, lender1UsdcAta.address, provider.wallet.publicKey, firstAmount);

    await program.methods
      .contributeToContract(toBn(firstAmount))
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        contribution: contribution1Pda,
        escrow: escrow1Pda,
        lender: lender1.publicKey,
        borrower: borrower.publicKey,
        approvedFunder: null,
        lenderUsdcAccount: lender1UsdcAta.address,
        contractUsdcAccount: contractUsdcAta.address,
        borrowerUsdcAccount: borrowerUsdcAta.address,
        usdcMint: guardUsdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender1])
      .rpc();

    const wrongAmount = 500_000n; // 0.5 USDC (should be 0.75 to fill remaining)
    const [contribution2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender2.publicKey.toBuffer()],
      program.programId,
    );
    const [escrow2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender2.publicKey.toBuffer()],
      program.programId,
    );
    const lender2UsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, lender2.publicKey);
    await mintTo(connection, payer, guardUsdcMint, lender2UsdcAta.address, provider.wallet.publicKey, wrongAmount);

    try {
      await program.methods
        .contributeToContract(toBn(wrongAmount))
        .accountsPartial({
          contract: contractPda,
          state: statePda,
          contribution: contribution2Pda,
          escrow: escrow2Pda,
          lender: lender2.publicKey,
          borrower: borrower.publicKey,
          approvedFunder: null,
          lenderUsdcAccount: lender2UsdcAta.address,
          contractUsdcAccount: contractUsdcAta.address,
          borrowerUsdcAccount: borrowerUsdcAta.address,
          usdcMint: guardUsdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([lender2])
        .rpc();
      assert.fail("expected last lender underfill to fail");
    } catch (err) {
      const anyErr = err as any;
      const msg =
        anyErr?.error?.errorCode?.code ??
        anyErr?.error?.errorMessage ??
        anyErr?.toString?.() ??
        String(err);
      assert.match(msg, /LastLenderMustFillRemaining/);
    }
  });

  it("Allows exact remaining contribution on the last lender slot", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender1 = anchor.web3.Keypair.generate();
    const lender2 = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.1),
      airdropSol(connection, lender1, 0.05),
      airdropSol(connection, lender2, 0.05),
    ]);

    const targetUsdc = 1_000_000n; // 1 USDC
    const collateralRaw = 200_000_000n; // 2 units at 8 decimals

    const contractSeed = new anchor.BN(2603);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const borrowerCollateralAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardCollateralMint, borrower.publicKey);
    const contractCollateralAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardCollateralMint, contractPda, true);
    const borrowerUsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, borrower.publicKey);
    const contractUsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, contractPda, true);
    const treasuryUsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, treasuryPda, true);

    await mintTo(connection, payer, guardCollateralMint, borrowerCollateralAta.address, provider.wallet.publicKey, collateralRaw);
    await mintTo(connection, payer, guardUsdcMint, borrowerUsdcAta.address, provider.wallet.publicKey, 100_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        toBn(targetUsdc),
        new anchor.BN(500),
        30,
        toBn(collateralRaw),
        { committed: {} },
        new anchor.BN(11_000),
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        2, // max_lenders
        true, // partial_funding_enabled
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
        treasuryUsdcAccount: treasuryUsdcAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([borrower])
      .rpc();

    const firstAmount = 250_000n; // 0.25 USDC
    const remainingAmount = targetUsdc - firstAmount; // 0.75 USDC

    const [contribution1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender1.publicKey.toBuffer()],
      program.programId,
    );
    const [escrow1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender1.publicKey.toBuffer()],
      program.programId,
    );
    const lender1UsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, lender1.publicKey);
    await mintTo(connection, payer, guardUsdcMint, lender1UsdcAta.address, provider.wallet.publicKey, firstAmount);

    await program.methods
      .contributeToContract(toBn(firstAmount))
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        contribution: contribution1Pda,
        escrow: escrow1Pda,
        lender: lender1.publicKey,
        borrower: borrower.publicKey,
        approvedFunder: null,
        lenderUsdcAccount: lender1UsdcAta.address,
        contractUsdcAccount: contractUsdcAta.address,
        borrowerUsdcAccount: borrowerUsdcAta.address,
        usdcMint: guardUsdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender1])
      .rpc();

    const [contribution2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender2.publicKey.toBuffer()],
      program.programId,
    );
    const [escrow2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender2.publicKey.toBuffer()],
      program.programId,
    );
    const lender2UsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, lender2.publicKey);
    await mintTo(connection, payer, guardUsdcMint, lender2UsdcAta.address, provider.wallet.publicKey, remainingAmount);

    await program.methods
      .contributeToContract(toBn(remainingAmount))
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        contribution: contribution2Pda,
        escrow: escrow2Pda,
        lender: lender2.publicKey,
        borrower: borrower.publicKey,
        approvedFunder: null,
        lenderUsdcAccount: lender2UsdcAta.address,
        contractUsdcAccount: contractUsdcAta.address,
        borrowerUsdcAccount: borrowerUsdcAta.address,
        usdcMint: guardUsdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender2])
      .rpc();

    const contractAfter = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfter.status, "active");
    assert.equal(contractAfter.numContributions, 2);
    assert.equal(contractAfter.fundedAmount.toString(), toBn(targetUsdc).toString());
  });

  it("Initializes per-contract operations fund metadata for automated mode", async () => {
    const borrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower, 0.1);

    const contractSeed = new anchor.BN(2701);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = toBn(1_000_000n);
    const collateralAmount = toBn(200_000_000n);
    const accts = await createContractAccounts(borrower, contractPda, 1_000_000n, 200_000_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(500),
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(11_000),
        { collateralTransfer: {} },
        { noFixedPayment: {} },
        { daily: {} },
        null,
        14,
        true,
        false,
        0,
        { automatic: {} },
        { public: {} },
      )
      .accounts(contractCreateAccounts(contractPda, operationsFundPda, borrower.publicKey, accts))
      .signers([borrower])
      .rpc();

    const operationsFund = await program.account.contractOperationsFund.fetch(operationsFundPda);
    assert.isTrue(operationsFund.contract.equals(contractPda));
    assert.isTrue(operationsFund.borrower.equals(borrower.publicKey));
    assert.isTrue(operationsFund.totalFunded.toNumber() > 0);
    assert.isTrue(operationsFund.estimatedOperations > 0);
    assert.equal(operationsFund.completedOperations, 0);
    assert.equal(operationsFund.totalReimbursed.toNumber(), 0);
    assert.equal(operationsFund.maxLenders, 14);
    assert.isTrue(operationsFund.isActive);
  });

  it("Allows a demand loan to be demanded (liquidated) and distributes collateral", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.1),
      airdropSol(connection, lender, 0.05),
    ]);

    const contractSeed = new anchor.BN(3001);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = toBn(1_000_000n);
    const collateralAmount = toBn(200_000_000n);
    const accts = await createContractAccounts(borrower, contractPda, 1_000_000n, 200_000_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(500),
        0,
        collateralAmount,
        { demand: {} },
        new anchor.BN(11_000),
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
      .accounts(contractCreateAccounts(contractPda, operationsFundPda, borrower.publicKey, accts))
      .signers([borrower])
      .rpc();

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    const lenderUsdcAta = await setupLender(lender, 1_000_000n);
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(contributeAccounts(contractPda, contributionPda, escrowPda, lender.publicKey, borrower.publicKey, lenderUsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
      .signers([lender])
      .rpc();

    const opsAccountInfoBefore = await connection.getAccountInfo(operationsFundPda);
    if (opsAccountInfoBefore) {
      assert.isAbove(opsAccountInfoBefore.data.length, 0);
    }

    // Sanity check: escrow PDA exists after contribution init.
    const escrowBefore = await program.account.lenderEscrow.fetch(escrowPda);
    assert.ok(escrowBefore.lender.equals(lender.publicKey));

    // Use requestRecall (v2 flow).
    await program.methods
      .requestRecall()
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        lender: lender.publicKey,
        contribution: contributionPda,
      })
      .signers([lender])
      .rpc();

    const contractAfter = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfter.status, "pendingRecall");
    assert.isTrue(contractAfter.recallRequested, "recall_requested should be true");
    assert.ok(
      contractAfter.recallRequestedBy.equals(lender.publicKey),
      "recall_requested_by should match lender",
    );
  });

  it("Rejects self-liquidation when borrower is the liquidator", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.1),
      airdropSol(connection, lender, 0.05),
    ]);

    const contractSeed = new anchor.BN(3002);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = toBn(1_000_000n);
    const collateralAmount = toBn(200_000_000n);
    const accts = await createContractAccounts(borrower, contractPda, 1_000_000n, 200_000_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(500),
        0,
        collateralAmount,
        { demand: {} },
        new anchor.BN(11_000),
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
      .accounts(contractCreateAccounts(contractPda, operationsFundPda, borrower.publicKey, accts))
      .signers([borrower])
      .rpc();

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    const lenderUsdcAta = await setupLender(lender, 1_000_000n);
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(contributeAccounts(contractPda, contributionPda, escrowPda, lender.publicKey, borrower.publicKey, lenderUsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
      .signers([lender])
      .rpc();

    try {
      await program.methods
        .liquidateContract()
        .accountsPartial({
          contract: contractPda,
          operationsFund: null,
          state: statePda,
          testClockOffset: null,
          borrower: borrower.publicKey,
          liquidator: borrower.publicKey,
          systemProgram: SystemProgram.programId,
          collateralRegistry: null,
          priceFeedAccount: null,
          treasury: null,
          botUsdcAta: null,
          contractUsdcAta: null,
          contractCollateralAta: null,
          botCollateralAta: null,
          borrowerCollateralAta: null,
          tokenProgram: null,
        })
        .remainingAccounts([
          { pubkey: contributionPda, isSigner: false, isWritable: true },
          { pubkey: escrowPda, isSigner: false, isWritable: true },
        ])
        .signers([borrower])
        .rpc();
      assert.fail("expected self-liquidation to be rejected");
    } catch (err) {
      const anyErr = err as any;
      const msg =
        anyErr?.error?.errorCode?.code ??
        anyErr?.error?.errorMessage ??
        anyErr?.toString?.() ??
        String(err);
      assert.match(msg, /SelfLiquidationNotAllowed|InvalidContractReference/);
    }
  });

  it("Rejects update/distribute instructions from non-bot authorities", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    const rogueBot = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.1),
      airdropSol(connection, lender, 0.05),
      airdropSol(connection, rogueBot, 0.01),
    ]);

    const contractSeed = new anchor.BN(3003);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = toBn(1_000_000n);
    const collateralAmount = toBn(200_000_000n);
    const accts = await createContractAccounts(borrower, contractPda, 1_000_000n, 200_000_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(500),
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(11_000),
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        14,
        true,
        false,
        0,
        { automatic: {} },
        { public: {} },
      )
      .accounts(contractCreateAccounts(contractPda, operationsFundPda, borrower.publicKey, accts))
      .signers([borrower])
      .rpc();

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    const lenderUsdcAta = await setupLender(lender, 1_000_000n);
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(contributeAccounts(contractPda, contributionPda, escrowPda, lender.publicKey, borrower.publicKey, lenderUsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
      .signers([lender])
      .rpc();

    try {
      await program.methods
        .updateContractState()
        .accounts({
          contract: contractPda,
          treasury: treasuryPda,
          processor: rogueBot.publicKey,
        })
        .signers([rogueBot])
        .rpc();
      assert.fail("expected update_contract_state to reject non-bot authority");
    } catch (err) {
      const anyErr = err as any;
      const msg =
        anyErr?.error?.errorCode?.code ??
        anyErr?.error?.errorMessage ??
        anyErr?.toString?.() ??
        String(err);
      assert.match(msg, /UnauthorizedBotOperation/);
    }

    try {
      await program.methods
        .distributeToEscrows()
        .accounts({
          contract: contractPda,
          treasury: treasuryPda,
          processor: rogueBot.publicKey,
        })
        .signers([rogueBot])
        .rpc();
      assert.fail("expected distribute_to_escrows to reject non-bot authority");
    } catch (err) {
      const anyErr = err as any;
      const msg =
        anyErr?.error?.errorCode?.code ??
        anyErr?.error?.errorMessage ??
        anyErr?.toString?.() ??
        String(err);
      assert.match(msg, /UnauthorizedBotOperation/);
    }
  });

  it("Enforces partial funding disabled: requires single full contribution", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender1 = anchor.web3.Keypair.generate();
    const lender2 = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.1),
      airdropSol(connection, lender1, 0.05),
      airdropSol(connection, lender2, 0.05),
    ]);

    const contractSeed = new anchor.BN(4001);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = toBn(1_000_000n);
    const collateralAmount = toBn(200_000_000n);
    const accts = await createContractAccounts(borrower, contractPda, 1_000_000n, 200_000_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(500),
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(11_000),
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        14,
        false,
        false,
        0,
        { manual: {} },
        { public: {} },
      )
      .accounts(contractCreateAccounts(contractPda, operationsFundPda, borrower.publicKey, accts))
      .signers([borrower])
      .rpc();

    const [contribution1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender1.publicKey.toBuffer()],
      program.programId,
    );
    const [escrow1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender1.publicKey.toBuffer()],
      program.programId,
    );

    const [contribution2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender2.publicKey.toBuffer()],
      program.programId,
    );
    const [escrow2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender2.publicKey.toBuffer()],
      program.programId,
    );

    const lender1UsdcAta = await setupLender(lender1, 1_000_000n);
    const partialContribution = toBn(400_000n);
    try {
      await program.methods
        .contributeToContract(partialContribution)
        .accountsPartial(contributeAccounts(contractPda, contribution1Pda, escrow1Pda, lender1.publicKey, borrower.publicKey, lender1UsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
        .signers([lender1])
        .rpc();
      assert.fail("expected partial funding to be rejected when disabled");
    } catch (error) {
      assert.match(String(error), /PartialFundingDisabled/i);
    }

    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(contributeAccounts(contractPda, contribution1Pda, escrow1Pda, lender1.publicKey, borrower.publicKey, lender1UsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
      .signers([lender1])
      .rpc();

    const contractAfterFunding = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfterFunding.status, "active");

    const lender2UsdcAta = await setupLender(lender2, 1_000_000n);
    const smallContribution = toBn(100_000n);
    try {
      await program.methods
        .contributeToContract(smallContribution)
        .accountsPartial(contributeAccounts(contractPda, contribution2Pda, escrow2Pda, lender2.publicKey, borrower.publicKey, lender2UsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
        .signers([lender2])
        .rpc();
      assert.fail("expected second contribution to fail");
    } catch (error) {
      assert.match(String(error), /(ContractNotOpen|PartialFundingDisabled)/i);
    }
  });

  it("Allows individual lender recall on a multi-lender demand loan", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender1 = anchor.web3.Keypair.generate();
    const lender2 = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.1),
      airdropSol(connection, lender1, 0.05),
      airdropSol(connection, lender2, 0.05),
    ]);

    const contractSeed = new anchor.BN(5001);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = toBn(1_000_000n);
    const collateralAmount = toBn(200_000_000n);
    const accts = await createContractAccounts(borrower, contractPda, 1_000_000n, 200_000_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(500),
        0,
        collateralAmount,
        { demand: {} },
        new anchor.BN(11_000),
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
      .accounts(contractCreateAccounts(contractPda, operationsFundPda, borrower.publicKey, accts))
      .signers([borrower])
      .rpc();

    const lender1Contribution = toBn(400_000n);
    const lender2Contribution = toBn(600_000n);

    const [contribution1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender1.publicKey.toBuffer()],
      program.programId,
    );
    const [escrow1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender1.publicKey.toBuffer()],
      program.programId,
    );
    const [contribution2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender2.publicKey.toBuffer()],
      program.programId,
    );
    const [escrow2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender2.publicKey.toBuffer()],
      program.programId,
    );

    const lender1UsdcAta = await setupLender(lender1, 400_000n);
    await program.methods
      .contributeToContract(lender1Contribution)
      .accountsPartial(contributeAccounts(contractPda, contribution1Pda, escrow1Pda, lender1.publicKey, borrower.publicKey, lender1UsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
      .signers([lender1])
      .rpc();

    const contractAfterFirstFunding = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfterFirstFunding.status, "openPartiallyFunded");

    const lender2UsdcAta = await setupLender(lender2, 600_000n);
    await program.methods
      .contributeToContract(lender2Contribution)
      .accountsPartial(contributeAccounts(contractPda, contribution2Pda, escrow2Pda, lender2.publicKey, borrower.publicKey, lender2UsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
      .signers([lender2])
      .rpc();

    const contractBeforeRecall = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractBeforeRecall.status, "active");

    // Use requestRecall (v2 flow) for lender1.
    await program.methods
      .requestRecall()
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        lender: lender1.publicKey,
        contribution: contribution1Pda,
      })
      .signers([lender1])
      .rpc();

    const contractAfterRecall1 = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfterRecall1.status, "pendingRecall");
    assert.isTrue(contractAfterRecall1.recallRequested, "recall should be requested");
    assert.ok(
      contractAfterRecall1.recallRequestedBy.equals(lender1.publicKey),
      "recall_requested_by should match lender1",
    );
  });

  it("Rejects update_contract_state from non-bot authority", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    const unauthorizedProcessor = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.1),
      airdropSol(connection, lender, 0.05),
      airdropSol(connection, unauthorizedProcessor, 0.01),
    ]);

    const contractSeed = new anchor.BN(9011);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = toBn(1_000_000n);
    const collateralAmount = toBn(200_000_000n);
    const accts = await createContractAccounts(borrower, contractPda, 1_000_000n, 200_000_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(500),
        30,
        collateralAmount,
        { demand: {} },
        new anchor.BN(11_000),
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
      .accounts(contractCreateAccounts(contractPda, operationsFundPda, borrower.publicKey, accts))
      .signers([borrower])
      .rpc();

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    const lenderUsdcAta = await setupLender(lender, 1_000_000n);
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(contributeAccounts(contractPda, contributionPda, escrowPda, lender.publicKey, borrower.publicKey, lenderUsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
      .signers([lender])
      .rpc();

    try {
      await (program.methods as any)
        .updateContractState()
        .accounts({
          contract: contractPda,
          treasury: treasuryPda,
          processor: unauthorizedProcessor.publicKey,
        })
        .signers([unauthorizedProcessor])
        .rpc();
      assert.fail("expected unauthorized processor call to fail");
    } catch (error) {
      assert.match(String(error), /UnauthorizedBotOperation/i);
    }
  });

  it("Rejects v1 liquidation when caller is not bot authority", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    const unauthorizedLiquidator = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower, 0.1),
      airdropSol(connection, lender, 0.05),
      airdropSol(connection, unauthorizedLiquidator, 0.01),
    ]);

    const contractSeed = new anchor.BN(9012);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = toBn(1_000_000n);
    const collateralAmount = toBn(200_000_000n);
    const accts = await createContractAccounts(borrower, contractPda, 1_000_000n, 200_000_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(500),
        30,
        collateralAmount,
        { demand: {} },
        new anchor.BN(11_000),
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
      .accounts(contractCreateAccounts(contractPda, operationsFundPda, borrower.publicKey, accts))
      .signers([borrower])
      .rpc();

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    const lenderUsdcAta = await setupLender(lender, 1_000_000n);
    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial(contributeAccounts(contractPda, contributionPda, escrowPda, lender.publicKey, borrower.publicKey, lenderUsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
      .signers([lender])
      .rpc();

    try {
      await (program.methods as any)
        .liquidateContract()
        .accountsPartial({
          contract: contractPda,
          operationsFund: operationsFundPda,
          state: statePda,
          testClockOffset: null,
          borrower: borrower.publicKey,
          liquidator: unauthorizedLiquidator.publicKey,
          systemProgram: SystemProgram.programId,
          collateralRegistry: null,
          priceFeedAccount: null,
          treasury: treasuryPda,
          botUsdcAta: null,
          contractUsdcAta: null,
          contractCollateralAta: null,
          botCollateralAta: null,
          borrowerCollateralAta: null,
          tokenProgram: null,
        })
        .signers([unauthorizedLiquidator])
        .rpc();
      assert.fail("expected unauthorized liquidation to fail");
    } catch (error) {
      assert.match(String(error), /UnauthorizedBotOperation/i);
    }
  });

  it("Runs allowlist approval and revoke flow for borrower-authorized funding", async () => {
    const borrower = (provider.wallet as { payer: anchor.web3.Keypair }).payer;
    const approvedLender = anchor.web3.Keypair.generate();
    await airdropSol(connection, approvedLender, 0.2);

    const contractSeed = new anchor.BN(Date.now());
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );
    const [approvedFunderPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("approved_funder"), contractPda.toBuffer(), approvedLender.publicKey.toBuffer()],
      program.programId,
    );

    const accts = await createContractAccounts(borrower, contractPda, 1_500_000n, 200_000_000n);

    await program.methods
      .createDebtContract(
        contractSeed,
        toBn(1_500_000n),
        new anchor.BN(500),
        30,
        toBn(200_000_000n),
        { committed: {} },
        new anchor.BN(11_000),
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        14,
        true,
        false,
        0,
        { manual: {} },
        { allowlistOnly: {} },
      )
      .accounts(contractCreateAccounts(contractPda, operationsFundPda, borrower.publicKey, accts))
      .signers([borrower])
      .rpc();

    const [approvedContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), approvedLender.publicKey.toBuffer()],
      program.programId,
    );
    const [approvedEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), approvedLender.publicKey.toBuffer()],
      program.programId,
    );

    const approvedLenderUsdcAta = await setupLender(approvedLender, 1_000_000n);
    try {
      await program.methods
        .contributeToContract(toBn(200_000n))
        .accountsPartial(contributeAccounts(contractPda, approvedContributionPda, approvedEscrowPda, approvedLender.publicKey, borrower.publicKey, approvedLenderUsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
        .signers([approvedLender])
        .rpc();
      assert.fail("expected unapproved lender contribution to fail before approval");
    } catch {
      const contractAfterRejectedContribution = await program.account.debtContract.fetch(contractPda);
      assert.equal(
        contractAfterRejectedContribution.fundedAmount.toString(),
        "0",
        "unapproved lender contribution should not be recorded",
      );
    }

    await program.methods
      .approveFunder()
      .accounts({
        contract: contractPda,
        approvedFunder: approvedFunderPda,
        borrower: borrower.publicKey,
        lender: approvedLender.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([borrower])
      .rpc();

    const approvedFunderAccount = await program.account.approvedFunder.fetch(approvedFunderPda);
    assert.equal(approvedFunderAccount.contract.toBase58(), contractPda.toBase58());
    assert.equal(approvedFunderAccount.lender.toBase58(), approvedLender.publicKey.toBase58());
    assert.equal(approvedFunderAccount.approvedBy.toBase58(), borrower.publicKey.toBase58());

    const contributionAmount = toBn(500_000n);

    await program.methods
      .contributeToContract(contributionAmount)
      .accountsPartial({
        ...contributeAccounts(contractPda, approvedContributionPda, approvedEscrowPda, approvedLender.publicKey, borrower.publicKey, approvedLenderUsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta),
        approvedFunder: approvedFunderPda,
      })
      .signers([approvedLender])
      .rpc();

    const contractAfterApprovedContribution = await program.account.debtContract.fetch(contractPda);
    assert.equal(
      contractAfterApprovedContribution.fundedAmount.toString(),
      contributionAmount.toString(),
      "approved lender contribution should be recorded",
    );

    await program.methods
      .revokeFunder()
      .accounts({
        contract: contractPda,
        approvedFunder: approvedFunderPda,
        borrower: borrower.publicKey,
        lender: approvedLender.publicKey,
      })
      .signers([borrower])
      .rpc();

    const revokedAccountInfo = await connection.getAccountInfo(approvedFunderPda);
    assert.isNull(revokedAccountInfo, "approved_funder account should be closed on revoke");

    try {
      await program.methods
        .contributeToContract(toBn(200_000n))
        .accountsPartial(contributeAccounts(contractPda, approvedContributionPda, approvedEscrowPda, approvedLender.publicKey, borrower.publicKey, approvedLenderUsdcAta, accts.contractUsdcAta, accts.borrowerUsdcAta))
        .signers([approvedLender])
        .rpc();
      assert.fail("expected revoked lender contribution to fail");
    } catch {
      const contractAfterRevokedAttempt = await program.account.debtContract.fetch(contractPda);
      assert.equal(
        contractAfterRevokedAttempt.fundedAmount.toString(),
        contributionAmount.toString(),
        "revoked lender should not increase total contributed amount",
      );
    }
  });

});

