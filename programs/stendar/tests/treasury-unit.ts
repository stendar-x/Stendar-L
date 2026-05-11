import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { Stendar } from "../../../target/types/stendar";
import { assert } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { createMint, getAssociatedTokenAddress } from "@solana/spl-token";
import {
  airdropSol,
  asTestProgram,
  expectTxFailure,
  refundTrackedKeypairs,
} from "../../../tests/test_helpers.ts";

const BPF_UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

describe("Treasury Unit Tests (Phase 8B)", () => {
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

  let payer: Keypair;
  let treasuryUsdcMint: PublicKey;

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

  async function ensureTreasuryInitialized(usdcMint: PublicKey): Promise<void> {
    const treasuryInfo = await connection.getAccountInfo(treasuryPda);
    if (!treasuryInfo) {
      await program.methods
        .initializeTreasury(provider.wallet.publicKey, usdcMint)
        .accountsPartial({
          treasury: treasuryPda,
          state: statePda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      treasuryUsdcMint = usdcMint;
      return;
    }

    const treasury = await workspaceProgram.account.treasury.fetch(treasuryPda);
    treasuryUsdcMint = treasury.usdcMint;
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
    const candidateMint = await createMint(
      connection,
      payer,
      provider.wallet.publicKey,
      null,
      6,
    );
    await ensureTreasuryInitialized(candidateMint);

    const treasury = await workspaceProgram.account.treasury.fetch(treasuryPda);
    if (!treasury.authority.equals(provider.wallet.publicKey)) {
      this.skip();
      return;
    }
  });

  after(async () => {
    await refundTrackedKeypairs(connection);
  });

  it("stores current initializeTreasury fields and derived USDC ATA", async () => {
    const treasury = await workspaceProgram.account.treasury.fetch(treasuryPda);
    const expectedTreasuryUsdcAta = await getAssociatedTokenAddress(
      treasury.usdcMint,
      treasuryPda,
      true,
    );

    assert.isTrue(treasury.authority.equals(provider.wallet.publicKey));
    assert.isTrue(treasury.pendingAuthority.equals(PublicKey.default));
    assert.isTrue(treasury.botAuthority.equals(provider.wallet.publicKey));
    assert.isAtLeast(treasury.createdAt.toNumber(), 1);
    assert.isAtLeast(treasury.lastUpdate.toNumber(), treasury.createdAt.toNumber());
    assert.isTrue(treasury.usdcMint.equals(treasuryUsdcMint));
    assert.isTrue(treasury.treasuryUsdcAccount.equals(expectedTreasuryUsdcAta));
  });

  it("rejects duplicate initializeTreasury calls", async () => {
    await expectTxFailure(
      program.methods
        .initializeTreasury(provider.wallet.publicKey, treasuryUsdcMint)
        .accountsPartial({
          treasury: treasuryPda,
          state: statePda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      /already in use/i,
    );
  });

  it("rejects zero-amount treasury withdrawal with exact Anchor error", async () => {
    await expectTxFailure(
      program.methods
        .withdrawFromTreasury(new anchor.BN(0))
        .accountsPartial({
          treasury: treasuryPda,
          authority: provider.wallet.publicKey,
          recipient: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "InvalidWithdrawalAmount",
    );
  });

  it("withdraws SOL with exact recipient and treasury deltas", async () => {
    const recipient = Keypair.generate();
    await airdropSol(connection, recipient, 0.01);

    const treasuryTopUp = 2_000_000;
    const withdrawAmount = 500_000;
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: treasuryPda,
          lamports: treasuryTopUp,
        }),
      ),
      [],
    );

    const recipientBefore = await connection.getBalance(recipient.publicKey, "confirmed");
    const treasuryBefore = await connection.getBalance(treasuryPda, "confirmed");

    await program.methods
      .withdrawFromTreasury(new anchor.BN(withdrawAmount))
      .accountsPartial({
        treasury: treasuryPda,
        authority: provider.wallet.publicKey,
        recipient: recipient.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const recipientAfter = await connection.getBalance(recipient.publicKey, "confirmed");
    const treasuryAfter = await connection.getBalance(treasuryPda, "confirmed");

    assert.equal(recipientAfter - recipientBefore, withdrawAmount);
    assert.equal(treasuryBefore - treasuryAfter, withdrawAmount);
  });
});