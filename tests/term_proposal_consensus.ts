import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import { PublicKey, SystemProgram } from "@solana/web3.js";
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

async function expectProgramError(
  txPromise: Promise<unknown>,
  fragments: string[],
): Promise<void> {
  try {
    await txPromise;
    assert.fail(`Expected transaction to fail with one of: ${fragments.join(", ")}`);
  } catch (error) {
    const message = String((error as { message?: string })?.message ?? error).toLowerCase();
    const matched = fragments.some((fragment) => message.includes(fragment.toLowerCase()));
    assert.isTrue(
      matched,
      `Expected error containing one of [${fragments.join(", ")}], got: ${message}`,
    );
  }
}

interface ContractFixture {
  borrower: anchor.web3.Keypair;
  lender: anchor.web3.Keypair;
  contractPda: PublicKey;
  contributionPda: PublicKey;
  escrowPda: PublicKey;
  statePda: PublicKey;
  lenderUsdcAta: PublicKey;
  borrowerUsdcAta: PublicKey;
  contractUsdcAta: PublicKey;
  contractCollateralAta: PublicKey;
}

describe("Term proposal consensus", () => {
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
  const [collateralRegistryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("collateral_registry")],
    program.programId,
  );
  let guardUsdcMint: PublicKey;
  let guardCollateralMint: PublicKey;
  let guardOraclePriceFeed: PublicKey;
  let treasuryUsdcAta: PublicKey;
  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_state")],
    program.programId,
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    program.programId,
  );
  const [testClockOffsetPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("test_clock_offset")],
    program.programId,
  );
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_UPGRADEABLE_LOADER_ID,
  );

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

  function mockOraclePda(seed: number): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle_price_feed"), new anchor.BN(seed).toArrayLike(Buffer, "le", 8)],
      program.programId,
    )[0];
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

    const feedPda = mockOraclePda(77701);
    guardOraclePriceFeed = feedPda;
    const slot = await connection.getSlot("confirmed");
    const blockTime = await connection.getBlockTime(slot);
    const publishTime = blockTime ?? Math.floor(Date.now() / 1000);

    const oracleInfo = await connection.getAccountInfo(feedPda);
    if (oracleInfo === null) {
      await program.methods
        .initializeMockOraclePriceFeed(
          new anchor.BN(77701),
          new anchor.BN(200_000_000),
          -8,
          new anchor.BN(publishTime),
        )
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: feedPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      await program.methods
        .setMockOraclePriceFeed(
          new anchor.BN(200_000_000),
          -8,
          new anchor.BN(publishTime),
        )
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: feedPda,
        })
        .rpc();
    }

    const existingRegistry = await connection.getAccountInfo(collateralRegistryPda, "confirmed");
    if (existingRegistry === null) {
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
    } catch (e: any) {
      const errStr = String(e);
      if (errStr.includes("CollateralRegistryFull") || errStr.includes("DuplicateCollateralMint") || errStr.includes("CollateralAlreadyRegistered")) {
        const registry = await program.account.collateralRegistry.fetch(collateralRegistryPda);
        const active = findMintableCollateralEntry(registry.collateralTypes as any[], provider.wallet.publicKey);
        if (active) {
          guardCollateralMint = active.mint;
          guardOraclePriceFeed = active.oraclePriceFeed;
          const refreshSlot = await connection.getSlot("confirmed");
          const refreshBlockTime = await connection.getBlockTime(refreshSlot);
          const refreshPublishTime = refreshBlockTime ?? Math.floor(Date.now() / 1000);
          await program.methods
            .setMockOraclePriceFeed(
              new anchor.BN(200_000_000),
              -8,
              new anchor.BN(refreshPublishTime),
            )
            .accounts({
              authority: provider.wallet.publicKey,
              state: statePda,
              mockOraclePriceFeed: guardOraclePriceFeed,
            })
            .rpc();
        } else {
          throw new Error("No active collateral type found in registry");
        }
      } else {
        throw e;
      }
    }

    treasuryUsdcAta = (await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, treasuryPda, true)).address;
  }

  async function createActiveSingleLenderContract(
    seed: number,
    loanType: "demand" | "committed" = "committed",
  ): Promise<ContractFixture> {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower, 0.1);
    await airdropSol(connection, lender, 0.05);

    const contractSeed = new anchor.BN(seed);
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
        new anchor.BN(900),
        90,
        collateralAmount,
        loanType === "demand" ? { demand: {} } : { committed: {} },
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

    const [contributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
      program.programId,
    );

    const lenderUsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, lender.publicKey);
    await mintTo(connection, payer, guardUsdcMint, lenderUsdcAta.address, provider.wallet.publicKey, BigInt(1_000_000));

    await program.methods
      .contributeToContract(targetAmount)
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        contribution: contributionPda,
        escrow: escrowPda,
        lender: lender.publicKey,
        borrower: borrower.publicKey,
        approvedFunder: null,
        contractUsdcAccount: contractUsdcAta.address,
        lenderUsdcAccount: lenderUsdcAta.address,
        borrowerUsdcAccount: borrowerUsdcAta.address,
        usdcMint: guardUsdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender])
      .rpc();

    const contractAccount = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAccount.status, "active");

    return {
      borrower,
      lender,
      contractPda,
      contributionPda,
      escrowPda,
      statePda,
      lenderUsdcAta: lenderUsdcAta.address,
      borrowerUsdcAta: borrowerUsdcAta.address,
      contractUsdcAta: contractUsdcAta.address,
      contractCollateralAta: contractCollateralAta.address,
    };
  }

  interface TwoLenderDemandFixture {
    borrower: anchor.web3.Keypair;
    lender1: anchor.web3.Keypair;
    lender2: anchor.web3.Keypair;
    contractPda: PublicKey;
    contribution1Pda: PublicKey;
    contribution2Pda: PublicKey;
    escrow1Pda: PublicKey;
    escrow2Pda: PublicKey;
    lender1UsdcAta: PublicKey;
    lender2UsdcAta: PublicKey;
    borrowerUsdcAta: PublicKey;
    contractUsdcAta: PublicKey;
    contractCollateralAta: PublicKey;
  }

  async function createActiveTwoLenderDemandContract(seed: number): Promise<TwoLenderDemandFixture> {
    const borrower = anchor.web3.Keypair.generate();
    const lender1 = anchor.web3.Keypair.generate();
    const lender2 = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower, 0.1);
    await airdropSol(connection, lender1, 0.05);
    await airdropSol(connection, lender2, 0.05);

    const contractSeed = new anchor.BN(seed);
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
    const lender1Contribution = new anchor.BN(400_000);
    const lender2Contribution = new anchor.BN(600_000);

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
        new anchor.BN(900),
        90,
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

    const lender1UsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, lender1.publicKey);
    const lender2UsdcAta = await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, lender2.publicKey);
    await mintTo(connection, payer, guardUsdcMint, lender1UsdcAta.address, provider.wallet.publicKey, BigInt(400_000));
    await mintTo(connection, payer, guardUsdcMint, lender2UsdcAta.address, provider.wallet.publicKey, BigInt(600_000));

    await program.methods
      .contributeToContract(lender1Contribution)
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        contribution: contribution1Pda,
        escrow: escrow1Pda,
        lender: lender1.publicKey,
        borrower: borrower.publicKey,
        approvedFunder: null,
        contractUsdcAccount: contractUsdcAta.address,
        lenderUsdcAccount: lender1UsdcAta.address,
        borrowerUsdcAccount: borrowerUsdcAta.address,
        usdcMint: guardUsdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender1])
      .rpc();
    await program.methods
      .contributeToContract(lender2Contribution)
      .accountsPartial({
        contract: contractPda,
        state: statePda,
        contribution: contribution2Pda,
        escrow: escrow2Pda,
        lender: lender2.publicKey,
        borrower: borrower.publicKey,
        approvedFunder: null,
        contractUsdcAccount: contractUsdcAta.address,
        lenderUsdcAccount: lender2UsdcAta.address,
        borrowerUsdcAccount: borrowerUsdcAta.address,
        usdcMint: guardUsdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([lender2])
      .rpc();

    const contractAccount = await program.account.debtContract.fetch(contractPda);
    expectAnchorEnumVariant(contractAccount.status, "active");

    return {
      borrower,
      lender1,
      lender2,
      contractPda,
      contribution1Pda,
      contribution2Pda,
      escrow1Pda,
      escrow2Pda,
      lender1UsdcAta: lender1UsdcAta.address,
      lender2UsdcAta: lender2UsdcAta.address,
      borrowerUsdcAta: borrowerUsdcAta.address,
      contractUsdcAta: contractUsdcAta.address,
      contractCollateralAta: contractCollateralAta.address,
    };
  }

  async function getBotTokenAccounts(): Promise<{ botUsdcAta: PublicKey; botCollateralAta: PublicKey }> {
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
    return {
      botUsdcAta: botUsdcAta.address,
      botCollateralAta: botCollateralAta.address,
    };
  }

  async function setTestClockOffset(offsetSeconds: number): Promise<void> {
    const accountInfo = await connection.getAccountInfo(testClockOffsetPda);
    const offset = new anchor.BN(offsetSeconds);
    if (accountInfo === null) {
      await program.methods
        .initializeTestClockOffset(offset)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          testClockOffset: testClockOffsetPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return;
    }

    await program.methods
      .setTestClockOffset(offset)
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        testClockOffset: testClockOffsetPda,
      })
      .rpc();
  }

  async function warpForwardSlots(slots: number): Promise<void> {
    const currentSlot = await connection.getSlot("confirmed");
    await (connection as any)._rpcRequest("warpSlot", [currentSlot + slots]);
  }

  function deriveProposalPda(contractPda: PublicKey, proposalId: number): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("term_proposal"), contractPda.toBuffer(), u64ToLeBytes(new anchor.BN(proposalId))],
      program.programId,
    )[0];
  }

  function deriveProposalVotePda(proposalPda: PublicKey, voter: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("proposal_vote"), proposalPda.toBuffer(), voter.toBuffer()],
      program.programId,
    )[0];
  }

  function deriveProposerCooldownPda(contractPda: PublicKey, proposer: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("proposer_cooldown"), contractPda.toBuffer(), proposer.toBuffer()],
      program.programId,
    )[0];
  }

  async function createProposal(
    fixture: ContractFixture,
    proposalId: number,
    proposer: anchor.web3.Keypair,
    proposedTermDays: number,
    recallOnRejection = false,
  ): Promise<PublicKey> {
    const proposalPda = deriveProposalPda(fixture.contractPda, proposalId);
    const proposerVotePda = deriveProposalVotePda(proposalPda, proposer.publicKey);
    const proposerCooldownPda = deriveProposerCooldownPda(fixture.contractPda, proposer.publicKey);

    await program.methods
      .createTermProposal(
        new anchor.BN(proposalId),
        900,
        proposedTermDays,
        { weekly: {} },
        null,
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        new anchor.BN(11_000),
        11_000,
        recallOnRejection,
      )
      .accounts({
        contract: fixture.contractPda,
        proposal: proposalPda,
        proposerVote: proposerVotePda,
        proposerCooldown: proposerCooldownPda,
        proposer: proposer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: fixture.contributionPda, isSigner: false, isWritable: false }])
      .signers([proposer])
      .rpc();

    return proposalPda;
  }

  async function voteOnProposal(
    fixture: ContractFixture,
    proposalId: number,
    voter: anchor.web3.Keypair,
    proposer: PublicKey,
    voteChoice: "approve" | "reject",
    recallOnRejection = false,
    voterContribution: PublicKey | null = null,
  ): Promise<void> {
    const proposalPda = deriveProposalPda(fixture.contractPda, proposalId);
    const votePda = deriveProposalVotePda(proposalPda, voter.publicKey);
    const proposerCooldownPda = deriveProposerCooldownPda(fixture.contractPda, proposer);

    await program.methods
      .voteOnProposal(
        new anchor.BN(proposalId),
        voteChoice === "approve" ? { approve: {} } : { reject: {} },
        recallOnRejection,
      )
      .accountsPartial({
        contract: fixture.contractPda,
        proposal: proposalPda,
        vote: votePda,
        voterContribution,
        proposerCooldown: proposerCooldownPda,
        voter: voter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([voter])
      .rpc();
  }

  before(async () => {
    await ensurePlatformInitialized();
    await initGuardInfrastructure();
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

  it("approves and applies terms after unanimous vote", async () => {
    const fixture = await createActiveSingleLenderContract(8_001);
    const proposalPda = await createProposal(fixture, 1, fixture.borrower, 45);

    const proposalBeforeVote = await program.account.termAmendmentProposal.fetch(proposalPda);
    expectAnchorEnumVariant(proposalBeforeVote.status, "pending");
    assert.equal(proposalBeforeVote.approvals, 1);
    assert.equal(proposalBeforeVote.totalParticipants, 2);

    await voteOnProposal(fixture, 1, fixture.lender, fixture.borrower.publicKey, "approve");

    const proposalAfterVote = await program.account.termAmendmentProposal.fetch(proposalPda);
    expectAnchorEnumVariant(proposalAfterVote.status, "approved");
    assert.equal(proposalAfterVote.approvals, 2);

    const contractAfterVote = await program.account.debtContract.fetch(fixture.contractPda);
    assert.equal(contractAfterVote.termDays, 45);
  });

  it("rejects proposal and enforces proposer cooldown", async () => {
    const fixture = await createActiveSingleLenderContract(8_002);
    const proposalPda = await createProposal(fixture, 1, fixture.borrower, 40);

    await voteOnProposal(fixture, 1, fixture.lender, fixture.borrower.publicKey, "reject");

    const rejectedProposal = await program.account.termAmendmentProposal.fetch(proposalPda);
    expectAnchorEnumVariant(rejectedProposal.status, "rejected");
    assert.equal(rejectedProposal.rejections, 1);

    const proposerCooldownPda = deriveProposerCooldownPda(fixture.contractPda, fixture.borrower.publicKey);
    const proposerCooldown = await program.account.proposerCooldown.fetch(proposerCooldownPda);
    assert.isAbove(
      proposerCooldown.cooldownUntil.toNumber(),
      Math.floor(Date.now() / 1000),
      "cooldown should be set in the future",
    );

    await expectProgramError(
      createProposal(fixture, 2, fixture.borrower, 50),
      ["ProposerOnCooldown", "proposeroncooldown", "on cooldown"],
    );
  });

  it("allows only proposer to cancel proposals and blocks further voting after cancel", async () => {
    const fixture = await createActiveSingleLenderContract(8_005);
    const proposalPda = await createProposal(fixture, 1, fixture.borrower, 44);

    await expectProgramError(
      program.methods
        .cancelTermProposal(new anchor.BN(1))
        .accounts({
          contract: fixture.contractPda,
          proposal: proposalPda,
          proposer: fixture.lender.publicKey,
        })
        .signers([fixture.lender])
        .rpc(),
      ["UnauthorizedProposalCancel", "unauthorized proposal cancel"],
    );

    await program.methods
      .cancelTermProposal(new anchor.BN(1))
      .accounts({
        contract: fixture.contractPda,
        proposal: proposalPda,
        proposer: fixture.borrower.publicKey,
      })
      .signers([fixture.borrower])
      .rpc();

    const cancelledProposal = await program.account.termAmendmentProposal.fetch(proposalPda);
    expectAnchorEnumVariant(cancelledProposal.status, "cancelled");

    await expectProgramError(
      voteOnProposal(fixture, 1, fixture.lender, fixture.borrower.publicKey, "approve"),
      ["ProposalNotPending", "proposal not pending"],
    );
  });

  it("closes proposal accounts only after resolution", async () => {
    const fixture = await createActiveSingleLenderContract(8_006);
    const proposalPda = await createProposal(fixture, 1, fixture.borrower, 44);

    await expectProgramError(
      program.methods
        .closeProposalAccounts(new anchor.BN(1))
        .accounts({
          contract: fixture.contractPda,
          proposal: proposalPda,
          proposerReceiver: fixture.borrower.publicKey,
        })
        .signers([fixture.borrower])
        .rpc(),
      ["ProposalNotPending", "proposal not pending"],
    );

    await program.methods
      .cancelTermProposal(new anchor.BN(1))
      .accounts({
        contract: fixture.contractPda,
        proposal: proposalPda,
        proposer: fixture.borrower.publicKey,
      })
      .signers([fixture.borrower])
      .rpc();

    const proposerLamportsBefore = await connection.getBalance(fixture.borrower.publicKey, "confirmed");
    const closeTxSig = await program.methods
      .closeProposalAccounts(new anchor.BN(1))
      .accounts({
        contract: fixture.contractPda,
        proposal: proposalPda,
        proposerReceiver: fixture.borrower.publicKey,
      })
      .signers([fixture.borrower])
      .rpc({ commitment: "confirmed" });
    await connection.confirmTransaction(closeTxSig, "confirmed");
    const proposerLamportsAfter = await connection.getBalance(fixture.borrower.publicKey, "confirmed");

    const proposalInfoAfterClose = await connection.getAccountInfo(proposalPda, "confirmed");
    if (proposalInfoAfterClose !== null) {
      assert.isTrue(
        proposalInfoAfterClose.lamports === 0 ||
          !proposalInfoAfterClose.owner.equals(program.programId),
        "resolved proposal account should be closed (0 lamports or reassigned to system program)",
      );
    }
    assert.isAbove(
      proposerLamportsAfter,
      proposerLamportsBefore,
      "closing a resolved proposal should reclaim rent to the proposer",
    );
  });

  it("rejects non-participants and repeat voting attempts", async () => {
    const fixture = await createActiveSingleLenderContract(8_007);
    await createProposal(fixture, 1, fixture.borrower, 46);

    const outsider = anchor.web3.Keypair.generate();
    await airdropSol(connection, outsider, 0.01);

    await expectProgramError(
      voteOnProposal(fixture, 1, outsider, fixture.borrower.publicKey, "approve"),
      ["NotContractParticipant", "not contract participant"],
    );

    await voteOnProposal(fixture, 1, fixture.lender, fixture.borrower.publicKey, "approve");

    await expectProgramError(
      voteOnProposal(fixture, 1, fixture.lender, fixture.borrower.publicKey, "approve"),
      ["AlreadyVoted", "ProposalNotPending", "already voted", "proposal not pending"],
    );
  });

  it("applies seller and buyer secondary fees on accepted offers", async () => {
    await program.methods
      .updateFeeRates(null, null, null, 1, 1)
      .accounts({
        state: statePda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const fixture = await createActiveSingleLenderContract(8_090);
    const buyer = anchor.web3.Keypair.generate();
    await airdropSol(connection, buyer, 0.05);

    const buyerUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardUsdcMint,
      buyer.publicKey,
    );
    await mintTo(
      connection,
      payer,
      guardUsdcMint,
      buyerUsdcAta.address,
      provider.wallet.publicKey,
      2_000_000n,
    );

    const listingNonce = 9;
    const offerNonce = 4;
    const tradeNonce = 13;
    const listingAmount = new anchor.BN(1_000_000);
    const salePrice = new anchor.BN(1_000_000);
    const now = Math.floor(Date.now() / 1000);

    const [listingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), fixture.contributionPda.toBuffer(), Buffer.from([listingNonce])],
      program.programId,
    );
    const [offerPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("offer"),
        listingPda.toBuffer(),
        buyer.publicKey.toBuffer(),
        Buffer.from([offerNonce]),
      ],
      program.programId,
    );
    const [tradeEventPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("trade"), listingPda.toBuffer(), Buffer.from([tradeNonce])],
      program.programId,
    );
    const [sellerEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), fixture.contractPda.toBuffer(), fixture.lender.publicKey.toBuffer()],
      program.programId,
    );
    const [buyerContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), fixture.contractPda.toBuffer(), buyer.publicKey.toBuffer()],
      program.programId,
    );
    const [buyerEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), fixture.contractPda.toBuffer(), buyer.publicKey.toBuffer()],
      program.programId,
    );

    await program.methods
      .createTradeListing(listingAmount, salePrice, new anchor.BN(now + 3_600), listingNonce)
      .accounts({
        listing: listingPda,
        contribution: fixture.contributionPda,
        contract: fixture.contractPda,
        state: fixture.statePda,
        seller: fixture.lender.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.lender])
      .rpc();

    await program.methods
      .createTradeOffer(listingAmount, salePrice, new anchor.BN(now + 1_800), offerNonce)
      .accounts({
        offer: offerPda,
        listing: listingPda,
        buyer: buyer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    const sellerBefore = (await getAccount(connection, fixture.lenderUsdcAta)).amount;
    const buyerBefore = (await getAccount(connection, buyerUsdcAta.address)).amount;
    const treasuryBefore = (await getAccount(connection, treasuryUsdcAta)).amount;

    await program.methods
      .acceptTradeOffer(tradeNonce)
      .accounts({
        listing: listingPda,
        offer: offerPda,
        contract: fixture.contractPda,
        tradeEvent: tradeEventPda,
        contribution: fixture.contributionPda,
        sellerEscrow: sellerEscrowPda,
        buyerContribution: buyerContributionPda,
        buyerEscrow: buyerEscrowPda,
        treasury: treasuryPda,
        state: fixture.statePda,
        seller: fixture.lender.publicKey,
        buyer: buyer.publicKey,
        buyerUsdcAccount: buyerUsdcAta.address,
        sellerUsdcAccount: fixture.lenderUsdcAta,
        treasuryUsdcAccount: treasuryUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.lender, buyer])
      .rpc();

    const sellerAfter = (await getAccount(connection, fixture.lenderUsdcAta)).amount;
    const buyerAfter = (await getAccount(connection, buyerUsdcAta.address)).amount;
    const treasuryAfter = (await getAccount(connection, treasuryUsdcAta)).amount;
    const tradeEvent = (await program.account.tradeEvent.fetch(tradeEventPda)) as any;

    const expectedSellerFee = 10n; // floor(1_000_000 * 1 / 100_000)
    const expectedBuyerFee = 10n; // floor(1_000_000 * 1 / 100_000)

    assert.equal((sellerAfter - sellerBefore).toString(), (1_000_000n - expectedSellerFee).toString());
    assert.equal((buyerBefore - buyerAfter).toString(), (1_000_000n + expectedBuyerFee).toString());
    assert.equal((treasuryAfter - treasuryBefore).toString(), (expectedSellerFee + expectedBuyerFee).toString());
    assert.equal(tradeEvent.platformFee.toString(), expectedSellerFee.toString());
    assert.equal(tradeEvent.buyerFee.toString(), expectedBuyerFee.toString());
  });

  it("allows only seller to cancel trade listings and closes listing account", async () => {
    const fixture = await createActiveSingleLenderContract(8_091);
    const listingNonce = 6;
    const [listingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), fixture.contributionPda.toBuffer(), Buffer.from([listingNonce])],
      program.programId,
    );
    const now = Math.floor(Date.now() / 1000);

    await program.methods
      .createTradeListing(
        new anchor.BN(1_000_000),
        new anchor.BN(1_000_000),
        new anchor.BN(now + 3_600),
        listingNonce,
      )
      .accounts({
        listing: listingPda,
        contribution: fixture.contributionPda,
        contract: fixture.contractPda,
        state: fixture.statePda,
        seller: fixture.lender.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.lender])
      .rpc();

    const attacker = anchor.web3.Keypair.generate();
    await airdropSol(connection, attacker, 0.01);

    await expectProgramError(
      program.methods
        .cancelTradeListing()
        .accounts({
          listing: listingPda,
          state: fixture.statePda,
          seller: attacker.publicKey,
        })
        .signers([attacker])
        .rpc(),
      ["UnauthorizedCancellation", "unauthorized cancellation"],
    );

    await program.methods
      .cancelTradeListing()
      .accounts({
        listing: listingPda,
        state: fixture.statePda,
        seller: fixture.lender.publicKey,
      })
      .signers([fixture.lender])
      .rpc();

    const listingInfoAfterCancel = await connection.getAccountInfo(listingPda, "confirmed");
    if (listingInfoAfterCancel !== null) {
      assert.isTrue(
        listingInfoAfterCancel.lamports === 0 ||
          !listingInfoAfterCancel.owner.equals(program.programId),
        "listing account should be closed (0 lamports or reassigned to system program)",
      );
    }
  });

  it("rejects acceptTradeOffer when signer is not the listing seller", async () => {
    const fixture = await createActiveSingleLenderContract(8_092);
    const buyer = anchor.web3.Keypair.generate();
    const attacker = anchor.web3.Keypair.generate();
    await airdropSol(connection, buyer, 0.05);
    await airdropSol(connection, attacker, 0.01);

    const buyerUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      guardUsdcMint,
      buyer.publicKey,
    );
    await mintTo(
      connection,
      payer,
      guardUsdcMint,
      buyerUsdcAta.address,
      provider.wallet.publicKey,
      2_000_000n,
    );

    const listingNonce = 7;
    const offerNonce = 5;
    const tradeNonce = 11;
    const now = Math.floor(Date.now() / 1000);
    const [listingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), fixture.contributionPda.toBuffer(), Buffer.from([listingNonce])],
      program.programId,
    );
    const [offerPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("offer"),
        listingPda.toBuffer(),
        buyer.publicKey.toBuffer(),
        Buffer.from([offerNonce]),
      ],
      program.programId,
    );
    const [tradeEventPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("trade"), listingPda.toBuffer(), Buffer.from([tradeNonce])],
      program.programId,
    );
    const [sellerEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), fixture.contractPda.toBuffer(), fixture.lender.publicKey.toBuffer()],
      program.programId,
    );
    const [buyerContributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("contribution"), fixture.contractPda.toBuffer(), buyer.publicKey.toBuffer()],
      program.programId,
    );
    const [buyerEscrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), fixture.contractPda.toBuffer(), buyer.publicKey.toBuffer()],
      program.programId,
    );

    await program.methods
      .createTradeListing(
        new anchor.BN(1_000_000),
        new anchor.BN(1_000_000),
        new anchor.BN(now + 3_600),
        listingNonce,
      )
      .accounts({
        listing: listingPda,
        contribution: fixture.contributionPda,
        contract: fixture.contractPda,
        state: fixture.statePda,
        seller: fixture.lender.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.lender])
      .rpc();

    await program.methods
      .createTradeOffer(
        new anchor.BN(1_000_000),
        new anchor.BN(1_000_000),
        new anchor.BN(now + 1_800),
        offerNonce,
      )
      .accounts({
        offer: offerPda,
        listing: listingPda,
        buyer: buyer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    await expectProgramError(
      program.methods
        .acceptTradeOffer(tradeNonce)
        .accounts({
          listing: listingPda,
          offer: offerPda,
          contract: fixture.contractPda,
          tradeEvent: tradeEventPda,
          contribution: fixture.contributionPda,
          sellerEscrow: sellerEscrowPda,
          buyerContribution: buyerContributionPda,
          buyerEscrow: buyerEscrowPda,
          treasury: treasuryPda,
          state: fixture.statePda,
          seller: attacker.publicKey,
          buyer: buyer.publicKey,
          buyerUsdcAccount: buyerUsdcAta.address,
          sellerUsdcAccount: fixture.lenderUsdcAta,
          treasuryUsdcAccount: treasuryUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker, buyer])
        .rpc(),
      ["UnauthorizedAcceptance", "unauthorized acceptance"],
    );
  });

  it("blocks trade listing while proposal is active", async () => {
    const fixture = await createActiveSingleLenderContract(8_003);
    await createProposal(fixture, 1, fixture.borrower, 42);

    const listingNonce = 1;
    const [listingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), fixture.contributionPda.toBuffer(), Buffer.from([listingNonce])],
      program.programId,
    );
    const now = Math.floor(Date.now() / 1000);

    await expectProgramError(
      program.methods
        .createTradeListing(
          new anchor.BN(200_000_000),
          new anchor.BN(190_000_000),
          new anchor.BN(now + 3_600),
          listingNonce,
        )
        .accounts({
          listing: listingPda,
          contribution: fixture.contributionPda,
          contract: fixture.contractPda,
          state: fixture.statePda,
          seller: fixture.lender.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([fixture.lender])
        .rpc(),
      ["ProposalAlreadyActive", "proposalalreadyactive", "active proposal"],
    );
  });

  it("fails to expire proposal before expiry window", async () => {
    const fixture = await createActiveSingleLenderContract(8_004);
    const proposalPda = await createProposal(fixture, 1, fixture.borrower, 41);
    const proposerCooldownPda = deriveProposerCooldownPda(fixture.contractPda, fixture.borrower.publicKey);

    await expectProgramError(
      program.methods
        .expireTermProposal(new anchor.BN(1))
        .accounts({
          contract: fixture.contractPda,
          proposal: proposalPda,
          proposerCooldown: proposerCooldownPda,
          executor: fixture.lender.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([fixture.lender])
        .rpc(),
      ["ProposalNotExpired", "proposalnotexpired", "not expired"],
    );
  });

  it("allows lender recall pledge on demand proposal creation", async () => {
    const fixture = await createActiveSingleLenderContract(8_110, "demand");
    const proposalPda = await createProposal(fixture, 1, fixture.lender, 44, true);
    const proposerVotePda = deriveProposalVotePda(proposalPda, fixture.lender.publicKey);

    const proposal = await program.account.termAmendmentProposal.fetch(proposalPda);
    const proposerVote = await program.account.proposalVote.fetch(proposerVotePda);

    assert.equal(proposal.recallPledgedCount, 1);
    assert.equal(proposal.recallPledgedAmount.toString(), "1000000");
    assert.equal(proposal.recallsProcessed, 0);
    assert.equal(proposal.recallGraceStart.toString(), "0");
    assert.isTrue(proposerVote.recallOnRejection);
  });

  it("rejects borrower recall pledge on proposal creation", async () => {
    const fixture = await createActiveSingleLenderContract(8_111, "demand");
    await expectProgramError(
      createProposal(fixture, 1, fixture.borrower, 44, true),
      ["RecallPledgeLenderOnly", "recallpledgelenderonly", "lender only"],
    );
  });

  it("rejects recall pledge on committed loan proposal creation", async () => {
    const fixture = await createActiveSingleLenderContract(8_112, "committed");
    await expectProgramError(
      createProposal(fixture, 1, fixture.lender, 44, true),
      [
        "RecallPledgeNotAllowedForCommittedLoans",
        "recallpledgenotallowedforcommittedloans",
        "committed loans",
      ],
    );
  });

  it("tracks lender recall pledge on vote", async () => {
    const fixture = await createActiveSingleLenderContract(8_113, "demand");
    const proposalPda = await createProposal(fixture, 1, fixture.borrower, 45, false);
    await voteOnProposal(
      fixture,
      1,
      fixture.lender,
      fixture.borrower.publicKey,
      "approve",
      true,
      fixture.contributionPda,
    );

    const votePda = deriveProposalVotePda(proposalPda, fixture.lender.publicKey);
    const voteAccount = await program.account.proposalVote.fetch(votePda);
    const proposal = await program.account.termAmendmentProposal.fetch(proposalPda);
    assert.isTrue(voteAccount.recallOnRejection);
    assert.equal(proposal.recallPledgedCount, 1);
    assert.equal(proposal.recallPledgedAmount.toString(), "1000000");
  });

  it("rejects borrower recall pledge on vote", async () => {
    const fixture = await createActiveSingleLenderContract(8_114, "demand");
    await createProposal(fixture, 1, fixture.lender, 45, false);
    await expectProgramError(
      voteOnProposal(
        fixture,
        1,
        fixture.borrower,
        fixture.lender.publicKey,
        "approve",
        true,
        null,
      ),
      ["RecallPledgeLenderOnly", "recallpledgelenderonly", "lender only"],
    );
  });

  it("sets rejection recall grace start only when pledges exist", async () => {
    const pledgedFixture = await createActiveSingleLenderContract(8_115, "demand");
    const pledgedProposalPda = await createProposal(pledgedFixture, 1, pledgedFixture.borrower, 42, false);
    await voteOnProposal(
      pledgedFixture,
      1,
      pledgedFixture.lender,
      pledgedFixture.borrower.publicKey,
      "reject",
      true,
      pledgedFixture.contributionPda,
    );
    const pledgedProposal = await program.account.termAmendmentProposal.fetch(pledgedProposalPda);
    expectAnchorEnumVariant(pledgedProposal.status, "rejected");
    assert.isTrue(pledgedProposal.recallGraceStart.toNumber() > 0);

    const noPledgeFixture = await createActiveSingleLenderContract(8_116, "demand");
    const noPledgeProposalPda = await createProposal(noPledgeFixture, 1, noPledgeFixture.borrower, 42, false);
    await voteOnProposal(
      noPledgeFixture,
      1,
      noPledgeFixture.lender,
      noPledgeFixture.borrower.publicKey,
      "reject",
      false,
      null,
    );
    const noPledgeProposal = await program.account.termAmendmentProposal.fetch(noPledgeProposalPda);
    expectAnchorEnumVariant(noPledgeProposal.status, "rejected");
    assert.equal(noPledgeProposal.recallGraceStart.toString(), "0");
  });

  it("enforces proposal recall grace period and then processes pledged recall", async () => {
    const fixture = await createActiveSingleLenderContract(8_117, "demand");
    const proposalPda = await createProposal(fixture, 1, fixture.borrower, 43, false);
    await voteOnProposal(
      fixture,
      1,
      fixture.lender,
      fixture.borrower.publicKey,
      "reject",
      true,
      fixture.contributionPda,
    );
    const votePda = deriveProposalVotePda(proposalPda, fixture.lender.publicKey);
    const escrowUsdcAta = (
      await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, fixture.escrowPda, true)
    ).address;
    const { botUsdcAta, botCollateralAta } = await getBotTokenAccounts();
    await mintTo(
      connection,
      payer,
      guardUsdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      BigInt(1_000_000),
    );

    const escrowBefore = (await getAccount(connection, escrowUsdcAta)).amount;
    const treasuryBefore = (await getAccount(connection, treasuryUsdcAta)).amount;

    await expectProgramError(
      program.methods
        .processProposalRecall(new anchor.BN(1))
        .accountsPartial({
          contract: fixture.contractPda,
          proposal: proposalPda,
          vote: votePda,
          botAuthority: provider.wallet.publicKey,
          treasury: treasuryPda,
          contribution: fixture.contributionPda,
          escrow: fixture.escrowPda,
          botUsdcAta,
          escrowUsdcAta,
          treasuryUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          botCollateralAta,
          borrower: fixture.borrower.publicKey,
          state: statePda,
          testClockOffset: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      ["ProposalRecallGraceNotElapsed", "proposalrecallgracenotelapsed", "grace period"],
    );

    try {
      await setTestClockOffset(172_900);
      await program.methods
        .processProposalRecall(new anchor.BN(1))
        .accountsPartial({
          contract: fixture.contractPda,
          proposal: proposalPda,
          vote: votePda,
          botAuthority: provider.wallet.publicKey,
          treasury: treasuryPda,
          contribution: fixture.contributionPda,
          escrow: fixture.escrowPda,
          botUsdcAta,
          escrowUsdcAta,
          treasuryUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          botCollateralAta,
          borrower: fixture.borrower.publicKey,
          state: statePda,
          testClockOffset: testClockOffsetPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } finally {
      await setTestClockOffset(0);
    }

    const escrowAfter = (await getAccount(connection, escrowUsdcAta)).amount;
    const treasuryAfter = (await getAccount(connection, treasuryUsdcAta)).amount;
    assert.equal((escrowAfter - escrowBefore).toString(), "980000");
    assert.equal((treasuryAfter - treasuryBefore).toString(), "20000");

    const contribution = await program.account.lenderContribution.fetch(fixture.contributionPda);
    assert.isTrue(contribution.isRefunded);

    const proposalAfter = await program.account.termAmendmentProposal.fetch(proposalPda);
    assert.equal(proposalAfter.recallsProcessed, 1);

    const contractAfter = await program.account.debtContract.fetch(fixture.contractPda);
    expectAnchorEnumVariant(contractAfter.status, "completed");
    assert.equal(contractAfter.numContributions, 0);
  });

  it("rejects process_proposal_recall when vote has no recall pledge", async () => {
    const fixture = await createActiveSingleLenderContract(8_118, "demand");
    const proposalPda = await createProposal(fixture, 1, fixture.borrower, 43, false);
    await voteOnProposal(
      fixture,
      1,
      fixture.lender,
      fixture.borrower.publicKey,
      "reject",
      false,
      null,
    );
    const votePda = deriveProposalVotePda(proposalPda, fixture.lender.publicKey);
    const escrowUsdcAta = (
      await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, fixture.escrowPda, true)
    ).address;
    const { botUsdcAta, botCollateralAta } = await getBotTokenAccounts();
    await mintTo(
      connection,
      payer,
      guardUsdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      BigInt(1_000_000),
    );

    await expectProgramError(
      program.methods
        .processProposalRecall(new anchor.BN(1))
        .accountsPartial({
          contract: fixture.contractPda,
          proposal: proposalPda,
          vote: votePda,
          botAuthority: provider.wallet.publicKey,
          treasury: treasuryPda,
          contribution: fixture.contributionPda,
          escrow: fixture.escrowPda,
          botUsdcAta,
          escrowUsdcAta,
          treasuryUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          botCollateralAta,
          borrower: fixture.borrower.publicKey,
          state: statePda,
          testClockOffset: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      ["NoRecallPledgeOnVote", "norecallpledgeonvote", "recall pledge"],
    );
  });

  it("processes multiple pledged recalls one lender at a time", async () => {
    const fixture = await createActiveTwoLenderDemandContract(8_119);
    const proposalPda = deriveProposalPda(fixture.contractPda, 1);
    const proposerVotePda = deriveProposalVotePda(proposalPda, fixture.lender1.publicKey);
    const proposerCooldownPda = deriveProposerCooldownPda(fixture.contractPda, fixture.lender1.publicKey);

    await program.methods
      .createTermProposal(
        new anchor.BN(1),
        900,
        40,
        { weekly: {} },
        null,
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        new anchor.BN(11_000),
        11_000,
        true,
      )
      .accounts({
        contract: fixture.contractPda,
        proposal: proposalPda,
        proposerVote: proposerVotePda,
        proposerCooldown: proposerCooldownPda,
        proposer: fixture.lender1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: fixture.contribution1Pda, isSigner: false, isWritable: false },
        { pubkey: fixture.contribution2Pda, isSigner: false, isWritable: false },
      ])
      .signers([fixture.lender1])
      .rpc();

    const borrowerVotePda = deriveProposalVotePda(proposalPda, fixture.borrower.publicKey);
    await program.methods
      .voteOnProposal(new anchor.BN(1), { approve: {} }, false)
      .accountsPartial({
        contract: fixture.contractPda,
        proposal: proposalPda,
        vote: borrowerVotePda,
        voterContribution: null,
        proposerCooldown: proposerCooldownPda,
        voter: fixture.borrower.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.borrower])
      .rpc();

    const lender2VotePda = deriveProposalVotePda(proposalPda, fixture.lender2.publicKey);
    await program.methods
      .voteOnProposal(new anchor.BN(1), { reject: {} }, true)
      .accountsPartial({
        contract: fixture.contractPda,
        proposal: proposalPda,
        vote: lender2VotePda,
        voterContribution: fixture.contribution2Pda,
        proposerCooldown: proposerCooldownPda,
        voter: fixture.lender2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.lender2])
      .rpc();

    const proposalAfterReject = await program.account.termAmendmentProposal.fetch(proposalPda);
    assert.equal(proposalAfterReject.recallPledgedCount, 2);
    assert.equal(proposalAfterReject.recallPledgedAmount.toString(), "1000000");

    const escrow1UsdcAta = (
      await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, fixture.escrow1Pda, true)
    ).address;
    const escrow2UsdcAta = (
      await getOrCreateAssociatedTokenAccount(connection, payer, guardUsdcMint, fixture.escrow2Pda, true)
    ).address;
    const { botUsdcAta, botCollateralAta } = await getBotTokenAccounts();
    await mintTo(
      connection,
      payer,
      guardUsdcMint,
      botUsdcAta,
      provider.wallet.publicKey,
      BigInt(1_000_000),
    );

    try {
      await setTestClockOffset(172_900);
      await program.methods
        .processProposalRecall(new anchor.BN(1))
        .accountsPartial({
          contract: fixture.contractPda,
          proposal: proposalPda,
          vote: proposerVotePda,
          botAuthority: provider.wallet.publicKey,
          treasury: treasuryPda,
          contribution: fixture.contribution1Pda,
          escrow: fixture.escrow1Pda,
          botUsdcAta,
          escrowUsdcAta: escrow1UsdcAta,
          treasuryUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          botCollateralAta,
          borrower: fixture.borrower.publicKey,
          state: statePda,
          testClockOffset: testClockOffsetPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const contractAfterFirst = await program.account.debtContract.fetch(fixture.contractPda);
      expectAnchorEnumVariant(contractAfterFirst.status, "active");
      assert.equal(contractAfterFirst.numContributions, 1);

      await program.methods
        .processProposalRecall(new anchor.BN(1))
        .accountsPartial({
          contract: fixture.contractPda,
          proposal: proposalPda,
          vote: lender2VotePda,
          botAuthority: provider.wallet.publicKey,
          treasury: treasuryPda,
          contribution: fixture.contribution2Pda,
          escrow: fixture.escrow2Pda,
          botUsdcAta,
          escrowUsdcAta: escrow2UsdcAta,
          treasuryUsdcAta,
          contractCollateralAta: fixture.contractCollateralAta,
          botCollateralAta,
          borrower: fixture.borrower.publicKey,
          state: statePda,
          testClockOffset: testClockOffsetPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } finally {
      await setTestClockOffset(0);
    }

    const finalContract = await program.account.debtContract.fetch(fixture.contractPda);
    expectAnchorEnumVariant(finalContract.status, "completed");
    assert.equal(finalContract.numContributions, 0);
    const finalProposal = await program.account.termAmendmentProposal.fetch(proposalPda);
    assert.equal(finalProposal.recallsProcessed, 2);
  });

  it("does not start recall grace on cancellation or approval with pledges", async () => {
    const cancelFixture = await createActiveSingleLenderContract(8_120, "demand");
    const cancelProposalPda = await createProposal(cancelFixture, 1, cancelFixture.lender, 44, true);
    await program.methods
      .cancelTermProposal(new anchor.BN(1))
      .accounts({
        contract: cancelFixture.contractPda,
        proposal: cancelProposalPda,
        proposer: cancelFixture.lender.publicKey,
      })
      .signers([cancelFixture.lender])
      .rpc();
    const cancelledProposal = await program.account.termAmendmentProposal.fetch(cancelProposalPda);
    expectAnchorEnumVariant(cancelledProposal.status, "cancelled");
    assert.equal(cancelledProposal.recallGraceStart.toString(), "0");

    const approveFixture = await createActiveSingleLenderContract(8_121, "demand");
    const approveProposalPda = await createProposal(approveFixture, 1, approveFixture.lender, 44, true);
    await voteOnProposal(
      approveFixture,
      1,
      approveFixture.borrower,
      approveFixture.lender.publicKey,
      "approve",
      false,
      null,
    );
    const approvedProposal = await program.account.termAmendmentProposal.fetch(approveProposalPda);
    expectAnchorEnumVariant(approvedProposal.status, "approved");
    assert.equal(approvedProposal.recallGraceStart.toString(), "0");
    assert.equal(approvedProposal.recallsProcessed, 0);
  });

  it("sets recall grace start when an expiring pledged proposal is expired", async function (this: Mocha.Context) {
    const fixture = await createActiveSingleLenderContract(8_122, "demand");
    const proposalPda = await createProposal(fixture, 1, fixture.lender, 44, true);
    const proposerCooldownPda = deriveProposerCooldownPda(fixture.contractPda, fixture.lender.publicKey);

    try {
      await warpForwardSlots(2_000_000);
    } catch {
      this.skip();
      return;
    }

    await program.methods
      .expireTermProposal(new anchor.BN(1))
      .accounts({
        contract: fixture.contractPda,
        proposal: proposalPda,
        proposerCooldown: proposerCooldownPda,
        executor: fixture.borrower.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.borrower])
      .rpc();

    const expiredProposal = await program.account.termAmendmentProposal.fetch(proposalPda);
    expectAnchorEnumVariant(expiredProposal.status, "expired");
    assert.isTrue(expiredProposal.recallGraceStart.toNumber() > 0);
  });
});
