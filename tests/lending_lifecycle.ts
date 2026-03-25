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
import type { Stendar } from "../target/types/stendar.ts";

const LAMPORTS_PER_SOL = anchor.web3.LAMPORTS_PER_SOL;
const BPF_UPGRADEABLE_LOADER_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

async function airdropSol(
  connection: anchor.web3.Connection,
  recipient: PublicKey,
  sol: number,
): Promise<void> {
  const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
  let airdropError: unknown;

  try {
    const sig = await connection.requestAirdrop(recipient, lamports);
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature: sig, ...latest },
      "confirmed",
    );
    return;
  } catch (error) {
    airdropError = error;
  }

  // Fallback for devnet faucet throttling: fund test signers from the provider wallet.
  const provider = anchor.getProvider();
  if (!(provider instanceof anchor.AnchorProvider)) {
    throw new Error("Airdrop failed and AnchorProvider is not configured");
  }

  const payer = (provider.wallet as { payer?: anchor.web3.Keypair }).payer;
  if (!payer) {
    throw new Error("Airdrop failed and provider wallet cannot sign fallback transfer");
  }

  const payerBalance = await connection.getBalance(payer.publicKey, "confirmed");
  const minimumRequired = lamports + 10_000;
  if (payerBalance < minimumRequired) {
    throw new Error(
      `Airdrop failed (${String(airdropError)}) and payer wallet is underfunded (${payerBalance} < ${minimumRequired} lamports)`,
    );
  }

  const transferSignature = await connection.sendTransaction(
    new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports,
      }),
    ),
    [payer],
    { preflightCommitment: "confirmed" },
  );
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature: transferSignature, ...latest },
    "confirmed",
  );
}

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
  const connection = provider.connection;
  const v1ContributeTokenAccounts = {
    contractUsdcAccount: null,
    lenderUsdcAccount: null,
    borrowerUsdcAccount: null,
    usdcMint: null,
    tokenProgram: null,
  } as const;
  const v1PaymentTokenAccounts = {
    borrowerUsdcAccount: null,
    contractUsdcAccount: null,
    contractCollateralAccount: null,
    borrowerCollateralAccount: null,
    tokenProgram: null,
  } as const;
  const v1ClaimTokenAccounts = {
    escrowUsdcAccount: null,
    lenderUsdcAccount: null,
    usdcMint: null,
    tokenProgram: null,
  } as const;
  const v1AutomatedTransferTokenAccounts = {
    contractUsdcAccount: null,
    tokenProgram: null,
  } as const;

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
    try {
      await program.account.state.fetch(statePda);
    } catch {
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

    try {
      await program.account.treasury.fetch(treasuryPda);
    } catch {
      await program.methods
        .initializeTreasury(provider.wallet.publicKey)
        .accounts({
          state: statePda,
          treasury: treasuryPda,
          state: statePda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  }

  async function initGuardInfrastructure(): Promise<void> {
    guardUsdcMint = await createMint(connection, payer, provider.wallet.publicKey, null, 6);
    guardCollateralMint = await createMint(connection, payer, provider.wallet.publicKey, null, 8);

    const feedPda = mockOraclePda(guardOracleSeed);
    const slot = await connection.getSlot("confirmed");
    const blockTime = await connection.getBlockTime(slot);
    const publishTime = blockTime ?? Math.floor(Date.now() / 1000);

    await program.methods
      .initializeMockOraclePriceFeed(guardOracleSeed, toBn(200_000_000n), -8, toBn(publishTime))
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        mockOraclePriceFeed: feedPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
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
  }

  before(async () => {
    await ensurePlatformInitialized();
    await initGuardInfrastructure();
  });

  it("Cancels an open contract and returns collateral", async () => {
    const borrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower.publicKey, 5);

    const contractSeed = new anchor.BN(1001);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const collateralAmount = new anchor.BN(0.5 * LAMPORTS_PER_SOL);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(1000), // 10% APR (basis points)
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(8000), // 80% LTV
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        14, // max_lenders
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
        collateralRegistry: null,
        collateralMint: null,
        borrowerCollateralAta: null,
        contractCollateralAta: null,
        priceFeedAccount: null,
        usdcMint: null,
        contractUsdcAta: null,
        borrowerUsdcAta: null,
        treasuryUsdcAccount: null,
        tokenProgram: null,
        associatedTokenProgram: null,
      })
      .signers([borrower])
      .rpc();

    const opsAccountInfoBefore = await connection.getAccountInfo(operationsFundPda);
    if (opsAccountInfoBefore) {
      assert.isAbove(opsAccountInfoBefore.data.length, 0);
    }

    const contractBefore = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractBefore.status, "openNotFunded");

    const contractLamportsBefore = await connection.getBalance(contractPda);

    await program.methods
      .cancelContract()
      .accounts({
        contract: contractPda,
        operationsFund: operationsFundPda,
        borrower: borrower.publicKey,
        contractCollateralAta: null,
        borrowerCollateralAta: null,
        tokenProgram: null,
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

    const contractLamportsAfter = await connection.getBalance(contractPda);
    assert.equal(
      contractLamportsBefore - contractLamportsAfter,
      collateralAmount.toNumber(),
      "contract collateral should be returned on cancel",
    );
  });

  it("Distributes a payment to escrow and allows lender to claim", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower.publicKey, 5),
      airdropSol(connection, lender.publicKey, 5),
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

    const targetAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const collateralAmount = new anchor.BN(0.5 * LAMPORTS_PER_SOL);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(0),
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(8000),
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        14, // max_lenders
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
        collateralRegistry: null,
        collateralMint: null,
        borrowerCollateralAta: null,
        contractCollateralAta: null,
        priceFeedAccount: null,
        usdcMint: null,
        contractUsdcAta: null,
        borrowerUsdcAta: null,
        treasuryUsdcAccount: null,
        tokenProgram: null,
        associatedTokenProgram: null,
      })
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

    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial({
        contract: contractPda,
        contribution: contributionPda,
        escrow: escrowPda,
        lender: lender.publicKey,
        borrower: borrower.publicKey,
        ...v1ContributeTokenAccounts,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender])
      .rpc();

    const contractAfterFunding = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfterFunding.status, "active");

    const paymentLamports = new anchor.BN(0.2 * LAMPORTS_PER_SOL);
    await program.methods
      .makePaymentWithDistribution(paymentLamports)
      .accountsPartial({
        contract: contractPda,
        operationsFund: operationsFundPda,
        state: statePda,
        borrower: borrower.publicKey,
        ...v1PaymentTokenAccounts,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: contributionPda, isSigner: false, isWritable: false },
        { pubkey: escrowPda, isSigner: false, isWritable: true },
      ])
      .signers([borrower])
      .rpc();

    const escrowBefore = await program.account.lenderEscrow.fetch(escrowPda);
    const availableBefore = escrowBefore.availableInterest
      .add(escrowBefore.availablePrincipal)
      .toNumber();
    assert.equal(availableBefore, paymentLamports.toNumber());

    const escrowLamportsBefore = await connection.getBalance(escrowPda);

    await program.methods
      .claimFromEscrow()
      .accountsPartial({
        contract: contractPda,
        escrow: escrowPda,
        lender: lender.publicKey,
        ...v1ClaimTokenAccounts,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender])
      .rpc();

    const escrowAfter = await program.account.lenderEscrow.fetch(escrowPda);
    assert.equal(escrowAfter.availableInterest.toNumber(), 0);
    assert.equal(escrowAfter.availablePrincipal.toNumber(), 0);

    const escrowLamportsAfter = await connection.getBalance(escrowPda);
    assert.equal(
      escrowLamportsBefore - escrowLamportsAfter,
      paymentLamports.toNumber(),
      "escrow should pay out exactly the available amount",
    );
  });

  it("Completes a fully repaid contract and refunds operations fund", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower.publicKey, 5),
      airdropSol(connection, lender.publicKey, 5),
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

    const targetAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const collateralAmount = new anchor.BN(0.5 * LAMPORTS_PER_SOL);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(0), // no interest for deterministic payoff
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(8000),
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        14, // max_lenders
        true, // partial_funding_enabled
        false,
        0,
        { automatic: {} },
        { public: {} },
      )
      .accounts({
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

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial({
        contract: contractPda,
        contribution: contributionPda,
        escrow: escrowPda,
        lender: lender.publicKey,
        borrower: borrower.publicKey,
        ...v1ContributeTokenAccounts,
        systemProgram: SystemProgram.programId,
      })
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
        ...v1PaymentTokenAccounts,
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
      airdropSol(connection, borrower.publicKey, 5),
      airdropSol(connection, lender1.publicKey, 5),
      airdropSol(connection, lender2.publicKey, 5),
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

    const targetAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const collateralAmount = new anchor.BN(0.5 * LAMPORTS_PER_SOL);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(0),
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(8000),
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        1, // max_lenders = 1
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

    const [contribution1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender1.publicKey.toBuffer()],
      program.programId,
    );
    const [escrow1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender1.publicKey.toBuffer()],
      program.programId,
    );

    // Partial funding keeps the contract in an "open" state, so the second lender hits
    // the max-lenders check (rather than ContractNotOpen).
    const firstContribution = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
    await program.methods
      .contributeToContract(firstContribution)
      .accountsPartial({
        contract: contractPda,
        contribution: contribution1Pda,
        escrow: escrow1Pda,
        lender: lender1.publicKey,
        borrower: borrower.publicKey,
        ...v1ContributeTokenAccounts,
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

    try {
      await program.methods
        .contributeToContract(new anchor.BN(1))
        .accountsPartial({
          contract: contractPda,
          contribution: contribution2Pda,
          escrow: escrow2Pda,
          lender: lender2.publicKey,
          borrower: borrower.publicKey,
          ...v1ContributeTokenAccounts,
          systemProgram: SystemProgram.programId,
        })
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
      assert.match(msg, /MaxLendersReached/);
    }
  });

  it("Rejects underfunding on the last lender slot", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender1 = anchor.web3.Keypair.generate();
    const lender2 = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower.publicKey, 5),
      airdropSol(connection, lender1.publicKey, 5),
      airdropSol(connection, lender2.publicKey, 5),
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
        new anchor.BN(0),
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
      airdropSol(connection, borrower.publicKey, 5),
      airdropSol(connection, lender1.publicKey, 5),
      airdropSol(connection, lender2.publicKey, 5),
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
        new anchor.BN(0),
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
    await airdropSol(connection, borrower.publicKey, 5);

    const contractSeed = new anchor.BN(2701);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const collateralAmount = new anchor.BN(0.5 * LAMPORTS_PER_SOL);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(0),
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(8000),
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
      .accounts({
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
      airdropSol(connection, borrower.publicKey, 5),
      airdropSol(connection, lender.publicKey, 5),
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

    const targetAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const collateralAmount = new anchor.BN(0.6 * LAMPORTS_PER_SOL);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(0),
        0, // demand loans can be recalled immediately
        collateralAmount,
        { demand: {} },
        new anchor.BN(8000),
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        14, // max_lenders
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

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial({
        contract: contractPda,
        contribution: contributionPda,
        escrow: escrowPda,
        lender: lender.publicKey,
        borrower: borrower.publicKey,
        ...v1ContributeTokenAccounts,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender])
      .rpc();

    const opsAccountInfoBefore = await connection.getAccountInfo(operationsFundPda);
    if (opsAccountInfoBefore) {
      assert.isAbove(opsAccountInfoBefore.data.length, 0);
    }

    // Sanity check: escrow PDA exists after contribution init.
    const escrowBefore = await program.account.lenderEscrow.fetch(escrowPda);
    assert.ok(escrowBefore.lender.equals(lender.publicKey));

    await program.methods
      .recallDemandContribution()
      .accounts({
        contract: contractPda,
        contribution: contributionPda,
        escrow: escrowPda,
        operationsFund: operationsFundPda,
        state: statePda,
        borrower: borrower.publicKey,
        lender: lender.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender])
      .rpc();

    const contractAfter = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfter.status, "liquidated");

    const opsAccountInfoAfter = await connection.getAccountInfo(operationsFundPda);
    assert.ok(
      opsAccountInfoAfter === null ||
        (opsAccountInfoAfter.lamports === 0 && opsAccountInfoAfter.data.length === 0),
      "operations fund should be closed on liquidation",
    );

    const escrowAccountInfo = await connection.getAccountInfo(escrowPda, "confirmed");
    assert.ok(
      escrowAccountInfo && escrowAccountInfo.data.length > 0,
      `escrow account missing after liquidation: ${escrowPda.toBase58()}`,
    );

    const escrowAfter = await program.account.lenderEscrow.fetch(escrowPda);
    assert.ok(
      escrowAfter.availablePrincipal.toNumber() > 0,
      "liquidation should allocate collateral into lender escrow",
    );
  });

  it("Rejects self-liquidation when borrower is the liquidator", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower.publicKey, 5),
      airdropSol(connection, lender.publicKey, 5),
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

    const targetAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const collateralAmount = new anchor.BN(0.6 * LAMPORTS_PER_SOL);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(0),
        0,
        collateralAmount,
        { demand: {} },
        new anchor.BN(8000),
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

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial({
        contract: contractPda,
        contribution: contributionPda,
        escrow: escrowPda,
        lender: lender.publicKey,
        borrower: borrower.publicKey,
        ...v1ContributeTokenAccounts,
        systemProgram: SystemProgram.programId,
      })
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
      assert.match(msg, /SelfLiquidationNotAllowed/);
    }
  });

  it("Rejects update/distribute instructions from non-bot authorities", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    const rogueBot = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower.publicKey, 5),
      airdropSol(connection, lender.publicKey, 5),
      airdropSol(connection, rogueBot.publicKey, 2),
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

    const targetAmount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
    const collateralAmount = new anchor.BN(0.06 * LAMPORTS_PER_SOL);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(0),
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(8000),
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
      .accounts({
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

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial({
        contract: contractPda,
        contribution: contributionPda,
        escrow: escrowPda,
        lender: lender.publicKey,
        borrower: borrower.publicKey,
        ...v1ContributeTokenAccounts,
        systemProgram: SystemProgram.programId,
      })
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
      airdropSol(connection, borrower.publicKey, 5),
      airdropSol(connection, lender1.publicKey, 5),
      airdropSol(connection, lender2.publicKey, 5),
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

    const targetAmount = new anchor.BN(10_000_000); // 0.01 SOL
    const collateralAmount = new anchor.BN(5_000_000); // 0.005 SOL

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(0),
        30,
        collateralAmount,
        { committed: {} },
        new anchor.BN(8000),
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        14, // max_lenders
        false, // partial_funding_enabled
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

    const partialContribution = new anchor.BN(4_000_000); // 0.004 SOL
    try {
      await program.methods
        .contributeToContract(partialContribution)
        .accountsPartial({
          contract: contractPda,
          contribution: contribution1Pda,
          escrow: escrow1Pda,
          lender: lender1.publicKey,
          borrower: borrower.publicKey,
          ...v1ContributeTokenAccounts,
          systemProgram: SystemProgram.programId,
        })
        .signers([lender1])
        .rpc();
      assert.fail("expected partial funding to be rejected when disabled");
    } catch (error) {
      assert.match(String(error), /PartialFundingDisabled/i);
    }

    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial({
        contract: contractPda,
        contribution: contribution1Pda,
        escrow: escrow1Pda,
        lender: lender1.publicKey,
        borrower: borrower.publicKey,
        ...v1ContributeTokenAccounts,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender1])
      .rpc();

    const contractAfterFunding = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfterFunding.status, "active");

    const smallContribution = new anchor.BN(1_000_000); // 0.001 SOL
    try {
      await program.methods
        .contributeToContract(smallContribution)
        .accountsPartial({
          contract: contractPda,
          contribution: contribution2Pda,
          escrow: escrow2Pda,
          lender: lender2.publicKey,
          borrower: borrower.publicKey,
          ...v1ContributeTokenAccounts,
          systemProgram: SystemProgram.programId,
        })
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
      airdropSol(connection, borrower.publicKey, 5),
      airdropSol(connection, lender1.publicKey, 5),
      airdropSol(connection, lender2.publicKey, 5),
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

    const targetAmount = new anchor.BN(10_000_000); // 0.01 SOL
    const collateralAmount = new anchor.BN(6_000_000); // 0.006 SOL

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(0),
        0,
        collateralAmount,
        { demand: {} },
        new anchor.BN(8000),
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { weekly: {} },
        null,
        14, // max_lenders
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

    const lender1Contribution = new anchor.BN(4_000_000); // 0.004 SOL
    const lender2Contribution = new anchor.BN(6_000_000); // 0.006 SOL

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

    await program.methods
      .contributeToContract(lender1Contribution)
      .accountsPartial({
        contract: contractPda,
        contribution: contribution1Pda,
        escrow: escrow1Pda,
        lender: lender1.publicKey,
        borrower: borrower.publicKey,
        ...v1ContributeTokenAccounts,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender1])
      .rpc();

    const contractAfterFirstFunding = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfterFirstFunding.status, "openPartiallyFunded");

    await program.methods
      .contributeToContract(lender2Contribution)
      .accountsPartial({
        contract: contractPda,
        contribution: contribution2Pda,
        escrow: escrow2Pda,
        lender: lender2.publicKey,
        borrower: borrower.publicKey,
        ...v1ContributeTokenAccounts,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender2])
      .rpc();

    const contractBeforeRecall = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractBeforeRecall.status, "active");

    const escrow1LamportsBefore = await connection.getBalance(escrow1Pda);
    const expectedShare1 = contractBeforeRecall.collateralAmount
      .mul(lender1Contribution)
      .div(contractBeforeRecall.fundedAmount);

    await program.methods
      .recallDemandContribution()
      .accounts({
        contract: contractPda,
        contribution: contribution1Pda,
        escrow: escrow1Pda,
        operationsFund: operationsFundPda,
        state: statePda,
        borrower: borrower.publicKey,
        lender: lender1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender1])
      .rpc();

    const contractAfterRecall1 = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfterRecall1.status, "active");
    assert.equal(
      contractAfterRecall1.fundedAmount.toNumber(),
      lender2Contribution.toNumber(),
      "funded amount should drop by recalled contribution",
    );

    const escrow1LamportsAfter = await connection.getBalance(escrow1Pda);
    assert.equal(
      escrow1LamportsAfter - escrow1LamportsBefore,
      expectedShare1.toNumber(),
      "escrow should receive lender's proportional collateral share",
    );

    const contribution1After = await program.account.lenderContribution.fetch(contribution1Pda);
    assert.equal(contribution1After.isRefunded, true, "recalled contribution should be marked refunded");

    const escrow2LamportsBefore = await connection.getBalance(escrow2Pda);
    const expectedShare2 = contractAfterRecall1.collateralAmount
      .mul(lender2Contribution)
      .div(contractAfterRecall1.fundedAmount);

    await program.methods
      .recallDemandContribution()
      .accounts({
        contract: contractPda,
        contribution: contribution2Pda,
        escrow: escrow2Pda,
        operationsFund: operationsFundPda,
        state: statePda,
        borrower: borrower.publicKey,
        lender: lender2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender2])
      .rpc();

    const contractAfterRecall2 = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAfterRecall2.status, "liquidated");
    assert.equal(contractAfterRecall2.fundedAmount.toNumber(), 0);

    const escrow2LamportsAfter = await connection.getBalance(escrow2Pda);
    assert.equal(
      escrow2LamportsAfter - escrow2LamportsBefore,
      expectedShare2.toNumber(),
      "second lender should receive remaining proportional collateral share",
    );

    const contribution2After = await program.account.lenderContribution.fetch(contribution2Pda);
    assert.equal(contribution2After.isRefunded, true, "second recalled contribution should be marked refunded");
  });

  it("Rejects request_recall on legacy v1 demand contracts", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower.publicKey, 5),
      airdropSol(connection, lender.publicKey, 5),
    ]);

    const contractSeed = new anchor.BN(6001);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const collateralAmount = new anchor.BN(0.6 * LAMPORTS_PER_SOL);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(0),
        0,
        collateralAmount,
        { demand: {} },
        new anchor.BN(8000),
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

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    await program.methods
      .contributeToContract(targetAmount)
      .accounts({
        contract: contractPda,
        contribution: contributionPda,
        escrow: escrowPda,
        lender: lender.publicKey,
        borrower: borrower.publicKey,
        ...v1ContributeTokenAccounts,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender])
      .rpc();

    try {
      await (program.methods as any)
        .requestRecall()
        .accounts({
          contract: contractPda,
          state: statePda,
          lender: lender.publicKey,
          contribution: contributionPda,
        })
        .signers([lender])
        .rpc();
      assert.fail("expected request_recall to fail on v1 contract");
    } catch (error) {
      assert.match(String(error), /(InvalidContractVersion|AccountNotSigner)/i);
    }
  });

  it("Rejects update_contract_state from non-bot authority", async () => {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    const unauthorizedProcessor = anchor.web3.Keypair.generate();
    await Promise.all([
      airdropSol(connection, borrower.publicKey, 5),
      airdropSol(connection, lender.publicKey, 5),
      airdropSol(connection, unauthorizedProcessor.publicKey, 2),
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

    const targetAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const collateralAmount = new anchor.BN(0.6 * LAMPORTS_PER_SOL);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(0),
        30,
        collateralAmount,
        { demand: {} },
        new anchor.BN(8000),
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

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    await program.methods
      .contributeToContract(targetAmount)
      .accounts({
        contract: contractPda,
        contribution: contributionPda,
        escrow: escrowPda,
        lender: lender.publicKey,
        borrower: borrower.publicKey,
        ...v1ContributeTokenAccounts,
        systemProgram: SystemProgram.programId,
      })
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
      airdropSol(connection, borrower.publicKey, 5),
      airdropSol(connection, lender.publicKey, 5),
      airdropSol(connection, unauthorizedLiquidator.publicKey, 2),
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

    const targetAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const collateralAmount = new anchor.BN(0.6 * LAMPORTS_PER_SOL);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(0),
        30,
        collateralAmount,
        { demand: {} },
        new anchor.BN(8000),
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

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    await program.methods
      .contributeToContract(targetAmount)
      .accounts({
        contract: contractPda,
        contribution: contributionPda,
        escrow: escrowPda,
        lender: lender.publicKey,
        borrower: borrower.publicKey,
        ...v1ContributeTokenAccounts,
        systemProgram: SystemProgram.programId,
      })
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
    await airdropSol(connection, approvedLender.publicKey, 0.2);

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

    await program.methods
      .createDebtContract(
        contractSeed,
        new anchor.BN(1_500_000),
        new anchor.BN(0),
        30,
        new anchor.BN(800_000),
        { committed: {} },
        new anchor.BN(8000),
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
      .accounts({
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
        borrowerUsdcAta: null,
        treasuryUsdcAccount: null,
        tokenProgram: null,
        associatedTokenProgram: null,
      })
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

    try {
      await program.methods
        .contributeToContract(new anchor.BN(200_000))
        .accounts({
          contract: contractPda,
          contribution: approvedContributionPda,
          escrow: approvedEscrowPda,
          lender: approvedLender.publicKey,
          borrower: borrower.publicKey,
          ...v1ContributeTokenAccounts,
          systemProgram: SystemProgram.programId,
        })
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

    const contributionAmount = new anchor.BN(500_000);

    await program.methods
      .contributeToContract(contributionAmount)
      .accounts({
        contract: contractPda,
        contribution: approvedContributionPda,
        escrow: approvedEscrowPda,
        lender: approvedLender.publicKey,
        borrower: borrower.publicKey,
        approvedFunder: approvedFunderPda,
        ...v1ContributeTokenAccounts,
        systemProgram: SystemProgram.programId,
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
        .contributeToContract(new anchor.BN(200_000))
        .accounts({
          contract: contractPda,
          contribution: approvedContributionPda,
          escrow: approvedEscrowPda,
          lender: approvedLender.publicKey,
          borrower: borrower.publicKey,
          ...v1ContributeTokenAccounts,
          systemProgram: SystemProgram.programId,
        })
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

