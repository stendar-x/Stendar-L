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
  refundTrackedKeypairs,
  u64ToLeBytes,
} from "../../../tests/test_helpers.ts";

const BPF_UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

describe("Treasury Integration Tests (Phase 8B)", () => {
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

  const nextContractSeed = createMonotonicSeedFactory(70_000);

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
  });

  after(async () => {
    await refundTrackedKeypairs(connection);
  });

  it("creates a USDC-denominated contract and books exact listing fee to treasury", async () => {
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

    const targetAmountRaw = 2_000_000n;
    await mintTo(
      connection,
      payer,
      usdcMint,
      borrowerUsdcAta.address,
      provider.wallet.publicKey,
      5_000_000n,
    );

    const stateBefore = await workspaceProgram.account.state.fetch(statePda);
    const treasuryBefore = await workspaceProgram.account.treasury.fetch(treasuryPda);
    const treasuryTokenBefore = (await getAccount(connection, treasuryUsdcAta)).amount;
    const borrowerTokenBefore = (await getAccount(connection, borrowerUsdcAta.address)).amount;

    const expectedListingFee =
      (targetAmountRaw * BigInt(stateBefore.primaryListingFeeBps)) / 100_000n;

    await program.methods
      .createDebtContract(
        contractSeed,
        2,
        new anchor.BN(targetAmountRaw.toString()),
        750,
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

    const contract = await workspaceProgram.account.debtContract.fetch(contractPda);
    const treasuryAfter = await workspaceProgram.account.treasury.fetch(treasuryPda);
    const treasuryTokenAfter = (await getAccount(connection, treasuryUsdcAta)).amount;
    const borrowerTokenAfter = (await getAccount(connection, borrowerUsdcAta.address)).amount;

    assert.isTrue(contract.borrower.equals(borrower.publicKey));
    assert.equal(contract.contractSeed.toString(), contractSeed.toString());
    assert.equal(contract.targetAmount.toString(), targetAmountRaw.toString());
    assert.equal(contract.maxLenders, 2);
    assert.equal(contract.listingFeePaid.toString(), expectedListingFee.toString());
    assert.isTrue(contract.loanMint.equals(usdcMint));
    assert.isTrue(contract.loanTokenAccount.equals(contractUsdcAta.address));
    assert.equal(contract.ltvRatio, 0);
    assert.property(contract.status as Record<string, unknown>, "openNotFunded");

    assert.equal(
      (treasuryTokenAfter - treasuryTokenBefore).toString(),
      expectedListingFee.toString(),
    );
    assert.equal(
      (borrowerTokenBefore - borrowerTokenAfter).toString(),
      expectedListingFee.toString(),
    );
    assert.equal(
      treasuryAfter.feesCollected.sub(treasuryBefore.feesCollected).toString(),
      expectedListingFee.toString(),
    );
  });
});