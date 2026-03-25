import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import { PublicKey, SystemProgram } from "@solana/web3.js";
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
    await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    return;
  } catch (error) {
    airdropError = error;
  }

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
      `Airdrop failed (${String(airdropError)}) and payer wallet is underfunded (${payerBalance} < ${minimumRequired})`,
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
  await connection.confirmTransaction({ signature: transferSignature, ...latest }, "confirmed");
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
  statePda: PublicKey;
}

describe("Term proposal consensus", () => {
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
  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_state")],
    program.programId,
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    program.programId,
  );
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_UPGRADEABLE_LOADER_ID,
  );

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
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  }

  async function createActiveSingleLenderContract(seed: number): Promise<ContractFixture> {
    const borrower = anchor.web3.Keypair.generate();
    const lender = anchor.web3.Keypair.generate();
    await airdropSol(connection, borrower.publicKey, 5);
    await airdropSol(connection, lender.publicKey, 3);

    const contractSeed = new anchor.BN(seed);
    const [contractPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), u64ToLeBytes(contractSeed)],
      program.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      program.programId,
    );

    const targetAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);

    await program.methods
      .createDebtContract(
        contractSeed,
        targetAmount,
        new anchor.BN(900),
        30,
        new anchor.BN(0.5 * LAMPORTS_PER_SOL),
        { committed: {} },
        new anchor.BN(8_000),
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
        approvedFunder: null,
        contractUsdcAccount: null,
        lenderUsdcAccount: null,
        borrowerUsdcAccount: null,
        usdcMint: null,
        tokenProgram: null,
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
      statePda,
    };
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
        new anchor.BN(8_000),
        8_000,
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
  ): Promise<void> {
    const proposalPda = deriveProposalPda(fixture.contractPda, proposalId);
    const votePda = deriveProposalVotePda(proposalPda, voter.publicKey);
    const proposerCooldownPda = deriveProposerCooldownPda(fixture.contractPda, proposer);

    await program.methods
      .voteOnProposal(
        new anchor.BN(proposalId),
        voteChoice === "approve" ? { approve: {} } : { reject: {} },
      )
      .accounts({
        contract: fixture.contractPda,
        proposal: proposalPda,
        vote: votePda,
        proposerCooldown: proposerCooldownPda,
        voter: voter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([voter])
      .rpc();
  }

  before(async () => {
    await ensurePlatformInitialized();
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
});
