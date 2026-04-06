import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import {
  airdropSol,
  refundTrackedKeypairs,
  findMintableCollateralEntry,
} from "./test_helpers.ts";

type FundingMode = { public: Record<string, never> } | { allowlistOnly: Record<string, never> };

interface ContractFixture {
  borrower: anchor.web3.Keypair;
  contractPda: PublicKey;
  contractSeed: anchor.BN;
  targetUsdc: bigint;
  contractUsdcAta: PublicKey;
  borrowerUsdcAta: PublicKey;
}

interface ContributionFixture {
  lender: anchor.web3.Keypair;
  contributionPda: PublicKey;
  escrowPda: PublicKey;
  lenderUsdcAta: PublicKey;
  amount: bigint;
}

function u64ToLeBytes(value: anchor.BN): Buffer {
  return value.toArrayLike(Buffer, "le", 8);
}

function toBn(value: bigint | number): anchor.BN {
  return new anchor.BN(value.toString());
}

function extractErrorMessage(error: unknown): string {
  const anyError = error as any;
  return (
    anyError?.error?.errorCode?.code ??
    anyError?.error?.errorMessage ??
    anyError?.logs?.join("\n") ??
    anyError?.toString?.() ??
    String(error)
  );
}

async function warpForwardSlots(
  connection: anchor.web3.Connection,
  slots: number,
): Promise<void> {
  const currentSlot = await connection.getSlot("confirmed");
  await (connection as any)._rpcRequest("warpSlot", [currentSlot + slots]);
}

async function tokenAmount(
  connection: anchor.web3.Connection,
  tokenAccount: PublicKey,
): Promise<bigint> {
  const account = await getAccount(connection, tokenAccount, "confirmed");
  return account.amount;
}

describe("Lender withdrawal from open contracts", () => {
  const envProvider = anchor.AnchorProvider.env();
  const connection = new anchor.web3.Connection(
    envProvider.connection.rpcEndpoint,
    "confirmed",
  );
  const provider = new anchor.AnchorProvider(connection, envProvider.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
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
  const payer = (provider.wallet as anchor.Wallet & { payer: anchor.web3.Keypair }).payer;

  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_state")],
    program.programId,
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
  let guardOracleSeed = toBn(BigInt(Date.now()) + 97_000n);

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
        .accountsPartial({
          state: statePda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    const treasuryInfo = await connection.getAccountInfo(treasuryPda);
    if (!treasuryInfo) {
      await program.methods
        .initializeTreasury(provider.wallet.publicKey)
        .accountsPartial({
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

    const existingFeed = await connection.getAccountInfo(feedPda);
    if (existingFeed) {
      await program.methods
        .setMockOraclePriceFeed(toBn(200_000_000n), -8, toBn(publishTime))
        .accountsPartial({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: feedPda,
        })
        .rpc();
    } else {
      await program.methods
        .initializeMockOraclePriceFeed(guardOracleSeed, toBn(200_000_000n), -8, toBn(publishTime))
        .accountsPartial({
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
        .accountsPartial({
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

    try {
      await program.methods
        .addCollateralType(guardOraclePriceFeed, 8, 500, 11_000)
        .accountsPartial({
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
        const active = findMintableCollateralEntry(
          registry.collateralTypes as any[],
          provider.wallet.publicKey,
        );
        if (active) {
          guardCollateralMint = active.mint;
          guardOraclePriceFeed = active.oraclePriceFeed;
          const feedSlot = await connection.getSlot("confirmed");
          const feedBlockTime = await connection.getBlockTime(feedSlot);
          const feedPublishTime = feedBlockTime ?? Math.floor(Date.now() / 1000);
          await program.methods
            .setMockOraclePriceFeed(toBn(200_000_000n), -8, toBn(feedPublishTime))
            .accountsPartial({
              authority: provider.wallet.publicKey,
              state: statePda,
              mockOraclePriceFeed: guardOraclePriceFeed,
            })
            .rpc();
        } else {
          throw new Error("No active collateral type found in registry");
        }
      } else {
        throw err;
      }
    }
  }

  async function refreshOracle(): Promise<void> {
    const slot = await connection.getSlot("confirmed");
    const blockTime = await connection.getBlockTime(slot);
    const publishTime = blockTime ?? Math.floor(Date.now() / 1000);
    await program.methods
      .setMockOraclePriceFeed(toBn(200_000_000n), -8, toBn(publishTime))
      .accountsPartial({
        authority: provider.wallet.publicKey,
        state: statePda,
        mockOraclePriceFeed: guardOraclePriceFeed,
      })
      .rpc();
  }

  async function createOpenContract(options?: {
    targetUsdc?: bigint;
    maxLenders?: number;
    fundingAccessMode?: FundingMode;
  }): Promise<ContractFixture> {
    await refreshOracle();
    const borrower = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower, 0.1);

    const targetUsdc = options?.targetUsdc ?? 1_000_000n;
    const maxLenders = options?.maxLenders ?? 14;
    const fundingAccessMode = options?.fundingAccessMode ?? { public: {} };
    const collateralRaw = 200_000_000n;
    const contractSeed = toBn(BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 100_000)));

    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

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
    const treasuryUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardUsdcMint,
      treasuryPda,
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
      100_000n,
    );

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
        maxLenders,
        true,
        false,
        0,
        { manual: {} },
        fundingAccessMode,
      )
      .accountsPartial({
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

    return {
      borrower,
      contractPda,
      contractSeed,
      targetUsdc,
      contractUsdcAta: contractUsdcAta.address,
      borrowerUsdcAta: borrowerUsdcAta.address,
    };
  }

  async function contribute(
    fixture: ContractFixture,
    amount: bigint,
    options?: { lender?: anchor.web3.Keypair; approvedFunder?: PublicKey | null },
  ): Promise<ContributionFixture> {
    const lender = options?.lender ?? anchor.web3.Keypair.generate();
    await airdropSol(connection, lender, 0.05);

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), fixture.contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), fixture.contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
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

    await program.methods
      .contributeToContract(toBn(amount))
      .accountsPartial({
        contract: fixture.contractPda,
        state: statePda,
        contribution: contributionPda,
        escrow: escrowPda,
        lender: lender.publicKey,
        borrower: fixture.borrower.publicKey,
        approvedFunder: options?.approvedFunder ?? null,
        lenderUsdcAccount: lenderUsdcAta.address,
        contractUsdcAccount: fixture.contractUsdcAta,
        borrowerUsdcAccount: fixture.borrowerUsdcAta,
        usdcMint: guardUsdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender])
      .rpc();

    return {
      lender,
      contributionPda,
      escrowPda,
      lenderUsdcAta: lenderUsdcAta.address,
      amount,
    };
  }

  async function withdrawContribution(
    fixture: ContractFixture,
    signer: anchor.web3.Keypair,
    contributionPda: PublicKey,
    escrowPda: PublicKey,
    lenderUsdcAta: PublicKey,
  ): Promise<string> {
    return program.methods
      .withdrawContribution()
      .accountsPartial({
        contract: fixture.contractPda,
        contribution: contributionPda,
        escrow: escrowPda,
        lender: signer.publicKey,
        contractUsdcAccount: fixture.contractUsdcAta,
        lenderUsdcAccount: lenderUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([signer])
      .rpc();
  }

  async function withdrawAfterCooldown(
    fixture: ContractFixture,
    position: ContributionFixture,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await withdrawContribution(
          fixture,
          position.lender,
          position.contributionPda,
          position.escrowPda,
          position.lenderUsdcAta,
        );
        return;
      } catch (error) {
        const message = extractErrorMessage(error);
        if (!/WithdrawalCooldownNotElapsed/.test(message)) {
          throw error;
        }
        lastError = error;
      }
      await warpForwardSlots(connection, 200);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error(`cooldown did not elapse in time: ${extractErrorMessage(lastError)}`);
  }

  before(async () => {
    await ensurePlatformInitialized();
    await initGuardInfrastructure();
  });

  after(async () => {
    await refundTrackedKeypairs(connection);
  });

  it("fails if lender withdraws immediately after contributing", async () => {
    const fixture = await createOpenContract();
    const position = await contribute(fixture, 400_000n);

    try {
      await withdrawContribution(
        fixture,
        position.lender,
        position.contributionPda,
        position.escrowPda,
        position.lenderUsdcAta,
      );
      assert.fail("expected immediate withdraw to fail with cooldown");
    } catch (error) {
      assert.match(extractErrorMessage(error), /WithdrawalCooldownNotElapsed/);
    }
  });

  it("withdraws successfully after cooldown and closes contribution + escrow accounts", async () => {
    const fixture = await createOpenContract();
    const position = await contribute(fixture, 450_000n);

    const lenderBalanceBefore = await tokenAmount(connection, position.lenderUsdcAta);
    const contractBalanceBefore = await tokenAmount(connection, fixture.contractUsdcAta);

    await withdrawAfterCooldown(fixture, position);

    const lenderBalanceAfter = await tokenAmount(connection, position.lenderUsdcAta);
    const contractBalanceAfter = await tokenAmount(connection, fixture.contractUsdcAta);

    assert.equal(
      (lenderBalanceAfter - lenderBalanceBefore).toString(),
      position.amount.toString(),
      "withdraw should return the full contribution amount to lender",
    );
    assert.equal(
      (contractBalanceBefore - contractBalanceAfter).toString(),
      position.amount.toString(),
      "contract USDC vault should decrease by withdrawn amount",
    );

    const contributionInfo = await connection.getAccountInfo(position.contributionPda);
    const escrowInfo = await connection.getAccountInfo(position.escrowPda);
    assert.isNull(contributionInfo, "contribution account should be closed");
    assert.isNull(escrowInfo, "escrow account should be closed");
  });

  it("rejects withdrawal when contract is already active", async () => {
    const fixture = await createOpenContract({ targetUsdc: 1_000_000n });
    const position = await contribute(fixture, 1_000_000n);

    const contractAfterFunding = await program.account.debtContract.fetch(fixture.contractPda);
    assert.ok("active" in (contractAfterFunding.status as Record<string, unknown>));

    try {
      await withdrawContribution(
        fixture,
        position.lender,
        position.contributionPda,
        position.escrowPda,
        position.lenderUsdcAta,
      );
      assert.fail("expected active contract withdrawal to fail");
    } catch (error) {
      assert.match(extractErrorMessage(error), /ContractNotOpenForWithdrawal/);
    }
  });

  it("reverts contract status to OpenNotFunded when withdrawing the last contribution", async () => {
    const fixture = await createOpenContract();
    const position = await contribute(fixture, 300_000n);

    await withdrawAfterCooldown(fixture, position);

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    assert.ok("openNotFunded" in (contractAfter.status as Record<string, unknown>));
    assert.equal(contractAfter.fundedAmount.toString(), "0");
    assert.equal(contractAfter.numContributions, 0);
    assert.lengthOf(contractAfter.contributions, 0);
  });

  it("keeps contract OpenPartiallyFunded when one of multiple lenders withdraws", async () => {
    const fixture = await createOpenContract();
    const lenderA = await contribute(fixture, 300_000n);
    const lenderB = await contribute(fixture, 200_000n);

    await withdrawAfterCooldown(fixture, lenderA);

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    assert.ok("openPartiallyFunded" in (contractAfter.status as Record<string, unknown>));
    assert.equal(contractAfter.fundedAmount.toString(), lenderB.amount.toString());
    assert.equal(contractAfter.numContributions, 1);
    assert.deepEqual(
      contractAfter.contributions.map((pubkey: PublicKey) => pubkey.toBase58()),
      [lenderB.contributionPda.toBase58()],
    );
  });

  it("preserves allowlist approval after withdrawal and allows re-contribution", async () => {
    const fixture = await createOpenContract({ fundingAccessMode: { allowlistOnly: {} } });
    const approvedLender = anchor.web3.Keypair.generate();
    await airdropSol(connection, approvedLender, 0.05);

    const [approvedFunderPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("approved_funder"), fixture.contractPda.toBuffer(), approvedLender.publicKey.toBuffer()],
      program.programId,
    );

    await program.methods
      .approveFunder()
      .accountsPartial({
        contract: fixture.contractPda,
        approvedFunder: approvedFunderPda,
        borrower: fixture.borrower.publicKey,
        lender: approvedLender.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.borrower])
      .rpc();

    const firstPosition = await contribute(fixture, 250_000n, {
      lender: approvedLender,
      approvedFunder: approvedFunderPda,
    });
    await withdrawAfterCooldown(fixture, firstPosition);

    const approvedFunderInfo = await connection.getAccountInfo(approvedFunderPda);
    assert.isNotNull(approvedFunderInfo, "approved_funder PDA should remain after withdraw");

    const secondPosition = await contribute(fixture, 125_000n, {
      lender: approvedLender,
      approvedFunder: approvedFunderPda,
    });

    const contractAfterSecondContribution = await program.account.debtContract.fetch(fixture.contractPda);
    assert.ok("openPartiallyFunded" in (contractAfterSecondContribution.status as Record<string, unknown>));
    assert.equal(contractAfterSecondContribution.fundedAmount.toString(), secondPosition.amount.toString());
    assert.equal(contractAfterSecondContribution.numContributions, 1);
  });

  it("fails when a non-contributor tries to withdraw another lender's contribution", async () => {
    const fixture = await createOpenContract();
    const position = await contribute(fixture, 350_000n);
    const attacker = anchor.web3.Keypair.generate();
    await airdropSol(connection, attacker, 0.01);
    const attackerUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardUsdcMint,
      attacker.publicKey,
    );

    try {
      await withdrawContribution(
        fixture,
        attacker,
        position.contributionPda,
        position.escrowPda,
        attackerUsdcAta.address,
      );
      assert.fail("expected non-contributor withdrawal attempt to fail");
    } catch (error) {
      assert.match(extractErrorMessage(error), /(ConstraintSeeds|UnauthorizedClaim|InvalidContribution)/);
    }
  });

  it("rejects duplicate contribution from the same lender on the same contract", async () => {
    const fixture = await createOpenContract();
    const lender = anchor.web3.Keypair.generate();
    await airdropSol(connection, lender, 0.05);

    const firstAmount = 200_000n;
    const secondAmount = 150_000n;

    const position = await contribute(fixture, firstAmount, { lender });

    const contractAfterFirst = await program.account.debtContract.fetch(fixture.contractPda);
    assert.equal(contractAfterFirst.fundedAmount.toString(), firstAmount.toString());
    assert.equal(contractAfterFirst.numContributions, 1);

    await mintTo(
      connection,
      payer,
      guardUsdcMint,
      position.lenderUsdcAta,
      provider.wallet.publicKey,
      secondAmount,
    );

    try {
      await program.methods
        .contributeToContract(toBn(secondAmount))
        .accountsPartial({
          contract: fixture.contractPda,
          state: statePda,
          contribution: position.contributionPda,
          escrow: position.escrowPda,
          lender: lender.publicKey,
          borrower: fixture.borrower.publicKey,
          approvedFunder: null,
          lenderUsdcAccount: position.lenderUsdcAta,
          contractUsdcAccount: fixture.contractUsdcAta,
          borrowerUsdcAccount: fixture.borrowerUsdcAta,
          usdcMint: guardUsdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([lender])
        .rpc();
      assert.fail("expected duplicate contribution to fail");
    } catch (error) {
      assert.match(
        extractErrorMessage(error),
        /FunderAlreadyApproved|already in use/,
      );
    }

    const contractUnchanged = await program.account.debtContract.fetch(fixture.contractPda);
    assert.equal(
      contractUnchanged.fundedAmount.toString(),
      firstAmount.toString(),
      "funded_amount should not change after rejected duplicate",
    );
  });

  it("preserves contribution timestamp after rejected duplicate", async () => {
    const fixture = await createOpenContract();
    const lender = anchor.web3.Keypair.generate();
    await airdropSol(connection, lender, 0.05);

    const position = await contribute(fixture, 200_000n, { lender });

    const stateAfterFirst = await program.account.lenderContribution.fetch(position.contributionPda);
    const firstTimestamp = stateAfterFirst.lastContributedAt.toNumber();
    assert.isAbove(firstTimestamp, 0, "initial timestamp should be set");

    try {
      await program.methods
        .contributeToContract(toBn(100_000n))
        .accountsPartial({
          contract: fixture.contractPda,
          state: statePda,
          contribution: position.contributionPda,
          escrow: position.escrowPda,
          lender: lender.publicKey,
          borrower: fixture.borrower.publicKey,
          approvedFunder: null,
          lenderUsdcAccount: position.lenderUsdcAta,
          contractUsdcAccount: fixture.contractUsdcAta,
          borrowerUsdcAccount: fixture.borrowerUsdcAta,
          usdcMint: guardUsdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([lender])
        .rpc();
      assert.fail("expected duplicate contribution to fail");
    } catch (error) {
      assert.match(
        extractErrorMessage(error),
        /FunderAlreadyApproved|already in use/,
      );
    }

    const stateAfterReject = await program.account.lenderContribution.fetch(position.contributionPda);
    assert.equal(
      stateAfterReject.lastContributedAt.toNumber(),
      firstTimestamp,
      "timestamp should not change after rejected duplicate",
    );
  });

  it("rejects single contribution exceeding target amount", async () => {
    const fixture = await createOpenContract({ targetUsdc: 500_000n });
    const lender = anchor.web3.Keypair.generate();
    await airdropSol(connection, lender, 0.05);

    const lenderUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection, payer, guardUsdcMint, lender.publicKey,
    );
    await mintTo(
      connection, payer, guardUsdcMint, lenderUsdcAta.address,
      provider.wallet.publicKey, 600_000n,
    );

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), fixture.contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), fixture.contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    const [approvedFunderPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("approved_funder"), fixture.contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    await program.methods
      .approveFunder()
      .accountsPartial({
        contract: fixture.contractPda,
        approvedFunder: approvedFunderPda,
        borrower: fixture.borrower.publicKey,
        lender: lender.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.borrower])
      .rpc();

    try {
      await program.methods
        .contributeToContract(toBn(600_000n))
        .accountsPartial({
          contract: fixture.contractPda,
          state: statePda,
          contribution: contributionPda,
          escrow: escrowPda,
          lender: lender.publicKey,
          borrower: fixture.borrower.publicKey,
          approvedFunder: approvedFunderPda,
          lenderUsdcAccount: lenderUsdcAta.address,
          contractUsdcAccount: fixture.contractUsdcAta,
          borrowerUsdcAccount: fixture.borrowerUsdcAta,
          usdcMint: guardUsdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([lender])
        .rpc();
      assert.fail("expected contribution exceeding target to fail");
    } catch (error) {
      assert.match(extractErrorMessage(error), /ExceedsTargetAmount/);
    }
  });
});
