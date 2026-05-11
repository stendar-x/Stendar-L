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
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  airdropSol,
  asTestProgram,
  expectTxFailure,
  refundTrackedKeypairs,
} from "../../../tests/test_helpers.ts";

const BPF_UPGRADEABLE_LOADER_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

describe("Treasury Security Tests (Phase 8B)", () => {
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
    const fallbackMint = await createMint(
      connection,
      payer,
      provider.wallet.publicKey,
      null,
      6,
    );
    await ensureTreasuryInitialized(fallbackMint);

    const treasury = await workspaceProgram.account.treasury.fetch(treasuryPda);
    if (!treasury.authority.equals(provider.wallet.publicKey)) {
      this.skip();
      return;
    }
  });

  after(async () => {
    await refundTrackedKeypairs(connection);
  });

  it("rejects unauthorized treasury withdrawal signer with exact error", async () => {
    const attacker = Keypair.generate();
    await airdropSol(connection, attacker, 0.02);

    await expectTxFailure(
      program.methods
        .withdrawFromTreasury(new anchor.BN(1))
        .accountsPartial({
          treasury: treasuryPda,
          authority: attacker.publicKey,
          recipient: attacker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc(),
      "UnauthorizedWithdrawal",
    );
  });

  it("rejects token withdrawal with incomplete token account set", async () => {
    const treasuryUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      treasuryUsdcMint,
      treasuryPda,
      true,
    );

    await expectTxFailure(
      program.methods
        .withdrawFromTreasury(new anchor.BN(1))
        .accountsPartial({
          treasury: treasuryPda,
          authority: provider.wallet.publicKey,
          recipient: provider.wallet.publicKey,
          treasuryUsdcAccount: treasuryUsdcAta.address,
          recipientUsdcAccount: null,
          tokenProgram: null,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "MissingTokenAccounts",
    );
  });

  it("rejects token withdrawal when treasury ATA does not match treasury record", async () => {
    const recipient = Keypair.generate();
    await airdropSol(connection, recipient, 0.01);

    const recipientUsdcAta = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      treasuryUsdcMint,
      recipient.publicKey,
    );

    await expectTxFailure(
      program.methods
        .withdrawFromTreasury(new anchor.BN(1))
        .accountsPartial({
          treasury: treasuryPda,
          authority: provider.wallet.publicKey,
          recipient: recipient.publicKey,
          treasuryUsdcAccount: recipientUsdcAta.address,
          recipientUsdcAccount: recipientUsdcAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "TokenAccountMismatch",
    );
  });

  it("rejects SOL withdrawal to non-system recipients", async () => {
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: treasuryPda,
          lamports: 50_000,
        }),
      ),
      [],
    );

    await expectTxFailure(
      program.methods
        .withdrawFromTreasury(new anchor.BN(1))
        .accountsPartial({
          treasury: treasuryPda,
          authority: provider.wallet.publicKey,
          recipient: workspaceProgram.programId,
          systemProgram: SystemProgram.programId,
        })
        .rpc(),
      "InvalidRecipient",
    );
  });
});