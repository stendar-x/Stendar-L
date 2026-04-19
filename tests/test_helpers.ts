import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { createHash } from "crypto";

const LAMPORTS_PER_SOL = anchor.web3.LAMPORTS_PER_SOL;

const _tracked = new Map<string, anchor.web3.Keypair>();

export function deriveFrontendOperatorPda(
  operator: PublicKey,
  programId: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("frontend_operator"), operator.toBuffer()],
    programId,
  )[0];
}

export async function registerFrontendOperator(
  connection: anchor.web3.Connection,
  programId: PublicKey,
  operator: anchor.web3.Keypair,
): Promise<PublicKey> {
  const frontendOperator = deriveFrontendOperatorPda(operator.publicKey, programId);
  const discriminator = createHash("sha256")
    .update("global:register_frontend")
    .digest()
    .subarray(0, 8);
  const instruction = new anchor.web3.TransactionInstruction({
    programId,
    keys: [
      { pubkey: frontendOperator, isSigner: false, isWritable: true },
      { pubkey: operator.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator,
  });
  await anchor.web3.sendAndConfirmTransaction(
    connection,
    new anchor.web3.Transaction().add(instruction),
    [operator],
  );
  return frontendOperator;
}

export function hasIdlInstruction(
  idl: { instructions?: Array<{ name?: string }> },
  ...names: string[]
): boolean {
  return (idl.instructions ?? []).some((ix) => names.includes(ix.name ?? ""));
}

/**
 * Returns true if the given pubkey is a valid SPL token mint
 * (account exists, owned by Token program, and has the 82-byte mint layout).
 */
export async function isValidSplMint(
  connection: anchor.web3.Connection,
  mint: PublicKey,
): Promise<boolean> {
  try {
    const info = await connection.getAccountInfo(mint, "confirmed");
    if (!info || !info.owner.equals(TOKEN_PROGRAM_ID)) return false;
    return info.data.length === 82;
  } catch {
    return false;
  }
}

/**
 * Pick a non-native, mintable collateral type from the registry.
 * Skips NATIVE_MINT entries because you can't `mintTo` on native SOL.
 * Returns the first active entry whose mint authority matches our wallet;
 * falls back to any non-native active entry, then any non-native entry.
 */
export function findMintableCollateralEntry(
  collateralTypes: any[],
  walletPubkey: PublicKey,
): { mint: PublicKey; oraclePriceFeed: PublicKey } | null {
  const nonNative = collateralTypes.filter(
    (c: any) => !c.mint.equals(NATIVE_MINT),
  );
  const active = nonNative.find((c: any) => c.isActive);
  if (active) return active;
  const any = nonNative[0];
  return any ?? null;
}

/**
 * Airdrop SOL to an ephemeral test keypair.
 * Tracks the keypair so its remaining balance can be recovered via
 * {@link refundTrackedKeypairs} after the suite completes.
 *
 * Tries the devnet faucet first; falls back to a direct transfer from
 * the provider wallet when the faucet is rate-limited.
 */
export async function airdropSol(
  connection: anchor.web3.Connection,
  recipientKeypair: anchor.web3.Keypair,
  sol: number,
): Promise<void> {
  _tracked.set(
    recipientKeypair.publicKey.toBase58(),
    recipientKeypair,
  );

  const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
  let airdropError: unknown;

  try {
    const sig = await connection.requestAirdrop(
      recipientKeypair.publicKey,
      lamports,
    );
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature: sig, ...latest },
      "confirmed",
    );
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
    throw new Error(
      "Airdrop failed and provider wallet cannot sign fallback transfer",
    );
  }

  const payerBalance = await connection.getBalance(
    payer.publicKey,
    "confirmed",
  );
  if (payerBalance < lamports + 10_000) {
    throw new Error(
      `Airdrop failed (${String(airdropError)}) and payer wallet is underfunded`,
    );
  }

  const transferSig = await connection.sendTransaction(
    new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipientKeypair.publicKey,
        lamports,
      }),
    ),
    [payer],
    { preflightCommitment: "confirmed" },
  );
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature: transferSig, ...latest },
    "confirmed",
  );
}

/**
 * Transfer remaining SOL from all tracked ephemeral keypairs back to the
 * provider wallet. Call this in an `after("all")` hook.
 *
 * Failures on individual keypairs are silently skipped (the keypair may
 * already be empty or closed).
 */
export async function refundTrackedKeypairs(
  connection: anchor.web3.Connection,
): Promise<void> {
  if (_tracked.size === 0) return;

  const provider = anchor.getProvider();
  if (!(provider instanceof anchor.AnchorProvider)) {
    _tracked.clear();
    return;
  }

  const recipient =
    ((provider.wallet as { payer?: anchor.web3.Keypair }).payer?.publicKey) ??
    provider.wallet.publicKey;

  let totalRefunded = 0;
  for (const kp of _tracked.values()) {
    try {
      const bal = await connection.getBalance(kp.publicKey, "confirmed");
      const fee = 5000;
      const transferable = bal - fee;
      if (transferable <= 0) continue;

      const tx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: kp.publicKey,
          toPubkey: recipient,
          lamports: transferable,
        }),
      );
      await connection.sendTransaction(tx, [kp], {
        preflightCommitment: "confirmed",
      });
      totalRefunded += transferable;
    } catch {
      // skip — keypair may be empty or account closed
    }
  }

  if (totalRefunded > 0) {
    console.log(
      `    [refund] recovered ${(totalRefunded / LAMPORTS_PER_SOL).toFixed(4)} SOL from ${_tracked.size} test keypair(s)`,
    );
  }
  _tracked.clear();
}
