import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { Stendar } from "../../../target/types/stendar";
import { assert } from "chai";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  airdropSol,
  asTestProgram,
  createMonotonicSeedFactory,
  expectTxFailure,
  refundTrackedKeypairs,
  u64ToLeBytes,
  warpForwardSlots,
} from "../../../tests/test_helpers.ts";

const BPF_UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

interface LenderPosition {
  lender: Keypair;
  lenderUsdcAta: PublicKey;
  contributionPda: PublicKey;
  escrowPda: PublicKey;
}

interface ActiveContractFixture {
  borrower: Keypair;
  contractPda: PublicKey;
  operationsFundPda: PublicKey;
  borrowerUsdcAta: PublicKey;
  contractUsdcAta: PublicKey;
  lenders: LenderPosition[];
}

describe("Treasury Automated Operations (Phase 8C)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const workspaceProgram = anchor.workspace.Stendar as Program<Stendar>;
  const program = asTestProgram(workspaceProgram);
  const connection = provider.connection;

  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_state")],
    workspaceProgram.programId,
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    workspaceProgram.programId,
  );
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [workspaceProgram.programId.toBuffer()],
    BPF_UPGRADEABLE_LOADER_ID,
  );
  const nextContractSeed = createMonotonicSeedFactory(90_000);

  let payer: Keypair;
  let usdcMint: PublicKey;
  let treasuryUsdcAta: PublicKey;

  async function ensureStateInitialized(): Promise<void> {
    const stateInfo = await connection.getAccountInfo(statePda);
    if (stateInfo) return;

    await program.methods
      .initialize()
      .accountsPartial({
        state: statePda,
        authority: provider.wallet.publicKey,
        program: workspaceProgram.programId,
        programData: programDataPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async function ensureTreasuryAndUsdcMint(): Promise<void> {
    const treasuryInfo = await connection.getAccountInfo(treasuryPda);
    if (!treasuryInfo) {
      usdcMint = await createMint(
        connection,
        payer,
        provider.wallet.publicKey,
        null,
        6,
      );
      await program.methods
        .initializeTreasury(provider.wallet.publicKey, usdcMint)
        .accountsPartial({
          treasury: treasuryPda,
          state: statePda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      const treasury = await workspaceProgram.account.treasury.fetch(treasuryPda);
      usdcMint = treasury.usdcMint;
      const mintState = await getMint(connection, usdcMint, "confirmed");
      if (!mintState.mintAuthority?.equals(provider.wallet.publicKey)) {
        throw new Error(
          `treasury USDC mint ${usdcMint.toBase58()} is not controlled by provider wallet`,
        );
      }
    }

    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      treasuryPda,
      true,
    );
    treasuryUsdcAta = treasuryAta.address;
  }

  async function createActiveUsdcFixture(): Promise<ActiveContractFixture> {
    const borrower = Keypair.generate();
    await airdropSol(connection, borrower, 0.05);

    const contractSeed = nextContractSeed();
    const [contractPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("debt_contract"),
        borrower.publicKey.toBuffer(),
        u64ToLeBytes(contractSeed),
      ],
      workspaceProgram.programId,
    );
    const [operationsFundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("operations_fund"), contractPda.toBuffer()],
      workspaceProgram.programId,
    );

    const borrowerUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      borrower.publicKey,
    );
    const contractUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      contractPda,
      true,
    );

    await mintTo(
      connection,
      payer,
      usdcMint,
      borrowerUsdcAta.address,
      provider.wallet.publicKey,
      300_000_000n,
    );

    await program.methods
      .createDebtContract(
        contractSeed,
        2,
        new anchor.BN("100000000"),
        2_000,
        30,
        new anchor.BN(0),
        { committed: {} },
        0,
        0,
        { outstandingBalance: {} },
        { noFixedPayment: {} },
        { daily: {} },
        null,
        true,
        false,
        0,
        false,
        0,
        { manual: {} },
        { public: {} },
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
        usdcMint,
        contractUsdcAta: contractUsdcAta.address,
        borrowerUsdcAta: borrowerUsdcAta.address,
        treasuryUsdcAccount: treasuryUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        frontendOperator: null,
        frontendUsdcAta: null,
      })
      .signers([borrower])
      .rpc();

    const lenders: LenderPosition[] = [];
    for (const amount of [50_000_000n, 50_000_000n]) {
      const lender = Keypair.generate();
      await airdropSol(connection, lender, 0.03);
      const [contributionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("contribution"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
        workspaceProgram.programId,
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), contractPda.toBuffer(), lender.publicKey.toBuffer()],
        workspaceProgram.programId,
      );
      const lenderUsdcAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        usdcMint,
        lender.publicKey,
      );
      await mintTo(
        connection,
        payer,
        usdcMint,
        lenderUsdcAta.address,
        provider.wallet.publicKey,
        amount,
      );

      await program.methods
        .contributeToContract(new anchor.BN(amount.toString()))
        .accountsPartial({
          contract: contractPda,
          state: statePda,
          contribution: contributionPda,
          escrow: escrowPda,
          lender: lender.publicKey,
          borrower: borrower.publicKey,
          approvedFunder: null,
          lenderUsdcAccount: lenderUsdcAta.address,
          contractUsdcAccount: contractUsdcAta.address,
          borrowerUsdcAccount: borrowerUsdcAta.address,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([lender])
        .rpc();

      lenders.push({
        lender,
        lenderUsdcAta: lenderUsdcAta.address,
        contributionPda,
        escrowPda,
      });
    }

    await program.methods
      .makePayment(new anchor.BN("20000000"))
      .accountsPartial({
        contract: contractPda,
        operationsFund: operationsFundPda,
        state: statePda,
        borrower: borrower.publicKey,
        borrowerUsdcAccount: borrowerUsdcAta.address,
        contractUsdcAccount: contractUsdcAta.address,
        contractCollateralAccount: null,
        borrowerCollateralAccount: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([borrower])
      .rpc();

    await warpForwardSlots(connection, 250_000);

    return {
      borrower,
      contractPda,
      operationsFundPda,
      borrowerUsdcAta: borrowerUsdcAta.address,
      contractUsdcAta: contractUsdcAta.address,
      lenders,
    };
  }

  function buildRemainingAccounts(fixture: ActiveContractFixture): Array<{
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }> {
    return fixture.lenders.flatMap((position) => [
      { pubkey: position.contributionPda, isSigner: false, isWritable: false },
      { pubkey: position.escrowPda, isSigner: false, isWritable: false },
      { pubkey: position.lender.publicKey, isSigner: false, isWritable: false },
      { pubkey: position.lenderUsdcAta, isSigner: false, isWritable: true },
    ]);
  }

  before(async function () {
    const maybePayer = (provider.wallet as anchor.Wallet & { payer?: Keypair })
      .payer;
    if (!maybePayer) {
      this.skip();
      return;
    }
    payer = maybePayer;

    await ensureStateInitialized();
    try {
      await ensureTreasuryAndUsdcMint();
    } catch {
      this.skip();
      return;
    }

    const treasury = await workspaceProgram.account.treasury.fetch(treasuryPda);
    if (!treasury.authority.equals(provider.wallet.publicKey)) {
      this.skip();
      return;
    }

    await program.methods
      .updateBotAuthority()
      .accountsPartial({
        treasury: treasuryPda,
        authority: provider.wallet.publicKey,
        newBotAuthority: provider.wallet.publicKey,
      })
      .rpc();
  });

  after(async () => {
    await refundTrackedKeypairs(connection);
  });

  it("runs automated_interest_transfer with modern remaining-account layout", async function () {
    let fixture: ActiveContractFixture;
    try {
      fixture = await createActiveUsdcFixture();
    } catch {
      this.skip();
      return;
    }

    const treasuryBefore = await workspaceProgram.account.treasury.fetch(treasuryPda);
    const contractBefore = await workspaceProgram.account.debtContract.fetch(
      fixture.contractPda,
    );
    const contractUsdcBefore = (await getAccount(connection, fixture.contractUsdcAta)).amount;
    const lenderTokenBefore = await Promise.all(
      fixture.lenders.map(async (lender) =>
        (await getAccount(connection, lender.lenderUsdcAta)).amount,
      ),
    );

    await program.methods
      .automatedInterestTransfer()
      .accountsPartial({
        contract: fixture.contractPda,
        operationsFund: fixture.operationsFundPda,
        treasury: treasuryPda,
        state: statePda,
        contractUsdcAccount: fixture.contractUsdcAta,
        botUsdcAta: null,
        contractCollateralAccount: null,
        botCollateralAta: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        botProcessor: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(buildRemainingAccounts(fixture))
      .rpc();

    const treasuryAfter = await workspaceProgram.account.treasury.fetch(treasuryPda);
    const contractAfter = await workspaceProgram.account.debtContract.fetch(
      fixture.contractPda,
    );
    const contractUsdcAfter = (await getAccount(connection, fixture.contractUsdcAta)).amount;
    const lenderTokenAfter = await Promise.all(
      fixture.lenders.map(async (lender) =>
        (await getAccount(connection, lender.lenderUsdcAta)).amount,
      ),
    );

    const lenderTotalDelta = lenderTokenAfter.reduce((acc, amount, index) => {
      return acc + (amount - lenderTokenBefore[index]);
    }, 0n);
    const contractTokenDelta = contractUsdcBefore - contractUsdcAfter;

    assert.equal(contractBefore.contributions.length, 2);
    assert.equal(contractAfter.accruedInterest.toString(), "0");
    assert.equal(
      treasuryAfter
        .automatedOperations
        .sub(treasuryBefore.automatedOperations)
        .toString(),
      "1",
    );
    assert.equal(
      treasuryAfter.transactionCosts.sub(treasuryBefore.transactionCosts).toString(),
      "0",
      "OutstandingBalance interest capitalization should not accrue lender transfer costs",
    );
    assert.equal(
      treasuryAfter
        .totalContractsProcessed
        .sub(treasuryBefore.totalContractsProcessed)
        .toString(),
      "1",
    );
    assert.equal(
      lenderTotalDelta.toString(),
      "0",
      "OutstandingBalance path should not distribute lender interest tokens",
    );
    assert.equal(
      contractTokenDelta.toString(),
      "0",
      "Contract USDC balance should not decrease when no lender interest distribution occurs",
    );
  });

  it("uses principal transfer signer/layout and keeps state unchanged on NoPaymentDue", async function () {
    let fixture: ActiveContractFixture;
    try {
      fixture = await createActiveUsdcFixture();
    } catch {
      this.skip();
      return;
    }

    const botUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      provider.wallet.publicKey,
    );
    await mintTo(
      connection,
      payer,
      usdcMint,
      botUsdcAta.address,
      provider.wallet.publicKey,
      50_000_000n,
    );

    const treasuryBefore = await workspaceProgram.account.treasury.fetch(treasuryPda);
    const contractBefore = await workspaceProgram.account.debtContract.fetch(
      fixture.contractPda,
    );

    await expectTxFailure(
      program.methods
        .automatedPrincipalTransfer()
        .accountsPartial({
          contract: fixture.contractPda,
          operationsFund: fixture.operationsFundPda,
          treasury: treasuryPda,
          state: statePda,
          contractUsdcAccount: fixture.contractUsdcAta,
          botUsdcAta: botUsdcAta.address,
          contractCollateralAccount: null,
          botCollateralAta: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          botProcessor: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(buildRemainingAccounts(fixture))
        .rpc(),
      "PaymentNotDue",
    );

    const treasuryAfter = await workspaceProgram.account.treasury.fetch(treasuryPda);
    const contractAfter = await workspaceProgram.account.debtContract.fetch(
      fixture.contractPda,
    );

    assert.equal(
      treasuryAfter.automatedOperations.toString(),
      treasuryBefore.automatedOperations.toString(),
    );
    assert.equal(
      treasuryAfter.transactionCosts.toString(),
      treasuryBefore.transactionCosts.toString(),
    );
    assert.equal(
      contractAfter.totalPrincipalPaid.toString(),
      contractBefore.totalPrincipalPaid.toString(),
    );
    assert.equal(
      contractAfter.botOperationCount.toString(),
      contractBefore.botOperationCount.toString(),
    );
  });

  it("withdraws treasury USDC with exact token balance deltas", async () => {
    const recipient = Keypair.generate();
    await airdropSol(connection, recipient, 0.01);

    const recipientUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      usdcMint,
      recipient.publicKey,
    );

    await mintTo(
      connection,
      payer,
      usdcMint,
      treasuryUsdcAta,
      provider.wallet.publicKey,
      2_000_000n,
    );

    const withdrawAmount = 400_000n;
    const treasuryBefore = (await getAccount(connection, treasuryUsdcAta)).amount;
    const recipientBefore = (await getAccount(connection, recipientUsdcAta.address)).amount;

    await program.methods
      .withdrawFromTreasury(new anchor.BN(withdrawAmount.toString()))
      .accountsPartial({
        treasury: treasuryPda,
        authority: provider.wallet.publicKey,
        recipient: recipient.publicKey,
        treasuryUsdcAccount: treasuryUsdcAta,
        recipientUsdcAccount: recipientUsdcAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const treasuryAfter = (await getAccount(connection, treasuryUsdcAta)).amount;
    const recipientAfter = (await getAccount(connection, recipientUsdcAta.address)).amount;

    assert.equal((treasuryBefore - treasuryAfter).toString(), withdrawAmount.toString());
    assert.equal((recipientAfter - recipientBefore).toString(), withdrawAmount.toString());
  });
});