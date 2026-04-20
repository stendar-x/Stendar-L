import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { airdropSol, refundTrackedKeypairs } from "./test_helpers.ts";

const BPF_UPGRADEABLE_LOADER_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const CLOCK_SYSVAR_ID = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const POOL_CHANGE_TIMELOCK_SECONDS = 72 * 60 * 60;

function toBn(value: bigint | number): anchor.BN {
  return new anchor.BN(value.toString());
}

function u64ToLeBytes(value: anchor.BN): Buffer {
  return value.toArrayLike(Buffer, "le", 8);
}

function encodePoolName(name: string): number[] {
  const buf = Buffer.alloc(32);
  buf.write(name.slice(0, 32), "utf8");
  return Array.from(buf);
}

function parseErrorMessage(error: unknown): string {
  const anyErr = error as {
    error?: { errorCode?: { code?: string }; errorMessage?: string };
    logs?: string[];
    message?: string;
    toString?: () => string;
  };
  return (
    anyErr?.error?.errorCode?.code ??
    anyErr?.error?.errorMessage ??
    anyErr?.logs?.join(" ") ??
    anyErr?.message ??
    anyErr?.toString?.() ??
    String(error)
  );
}

async function expectTxFailure(
  promise: Promise<unknown>,
  expectedMessagePart?: string,
): Promise<void> {
  try {
    await promise;
    assert.fail("Expected transaction to fail");
  } catch (error) {
    const message = parseErrorMessage(error);
    if (expectedMessagePart) {
      assert.include(
        message,
        expectedMessagePart,
        `expected error containing '${expectedMessagePart}', got: ${message}`,
      );
    }
  }
}

describe("Pool timelock changes", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const canWarpClock = /localhost|127\.0\.0\.1/.test(connection.rpcEndpoint ?? "");
  const payer = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;

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

  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_state")],
    program.programId,
  );
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_UPGRADEABLE_LOADER_ID,
  );

  let usdcMint: PublicKey;
  let poolSeedCounter = 91_000;

  function nextPoolSeed(): anchor.BN {
    poolSeedCounter += 1;
    return toBn(poolSeedCounter);
  }

  function deriveOperatorAuth(operator: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool_operator"), operator.toBuffer()],
      program.programId,
    )[0];
  }

  function derivePool(operator: PublicKey, poolSeed: anchor.BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), operator.toBuffer(), u64ToLeBytes(poolSeed)],
      program.programId,
    )[0];
  }

  function derivePendingPoolChange(pool: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pending_pool_change"), pool.toBuffer()],
      program.programId,
    )[0];
  }

  async function getClockUnixTimestamp(): Promise<number> {
    const clockInfo = await connection.getAccountInfo(CLOCK_SYSVAR_ID, "confirmed");
    assert.ok(clockInfo, "Clock sysvar account must exist");
    return Number(clockInfo.data.readBigInt64LE(32));
  }

  async function warpForwardSlots(slots: number): Promise<void> {
    const jump = Math.max(1, Math.floor(slots));
    const currentSlot = await connection.getSlot("confirmed");
    await (connection as any)._rpcRequest("warpSlot", [currentSlot + jump]);
  }

  async function advanceClockToTimestamp(targetTimestamp: number): Promise<number> {
    let current = await getClockUnixTimestamp();
    let safety = 0;

    // Coarse jumps first. On local validator unix_timestamp advances slower than slot count,
    // so this reaches the target quickly without 100k+ single-slot hops.
    while (current < targetTimestamp - 120) {
      const remaining = targetTimestamp - current;
      const jumpSlots = Math.max(1, remaining - 120);
      await warpForwardSlots(jumpSlots);
      current = await getClockUnixTimestamp();
      safety += 1;
      if (safety > 40) {
        throw new Error(`Failed to advance clock near ${targetTimestamp}; current=${current}`);
      }
    }

    while (current < targetTimestamp) {
      await warpForwardSlots(1);
      current = await getClockUnixTimestamp();
      safety += 1;
      if (safety > 10_000) {
        throw new Error(`Failed to reach target timestamp ${targetTimestamp}; current=${current}`);
      }
    }

    return current;
  }

  async function waitForAccountClosure(account: PublicKey, attempts = 15): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const info = await connection.getAccountInfo(account, "confirmed");
      if (info === null) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.fail(`expected account ${account.toBase58()} to be closed`);
  }

  async function ensureStateInitialized(): Promise<void> {
    const stateInfo = await connection.getAccountInfo(statePda);
    if (stateInfo === null) {
      await program.methods
        .initialize()
        .accountsPartial({
          state: statePda,
          authority: provider.wallet.publicKey,
          program: program.programId,
          programData: programDataPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  }

  async function authorizeOperator(operator: Keypair): Promise<PublicKey> {
    const operatorAuth = deriveOperatorAuth(operator.publicKey);
    await program.methods
      .authorizePoolOperator()
      .accounts({
        state: statePda,
        authority: provider.wallet.publicKey,
        operatorAuth,
        operator: operator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return operatorAuth;
  }

  async function createPoolForOperator(params: {
    operator: Keypair;
    operatorAuth: PublicKey;
    rateBps?: number;
    capacity?: bigint;
    minimumDeposit?: bigint;
    withdrawalQueueEnabled?: boolean;
    allowedLoanType?: number;
    minLtvBps?: number;
    maxTermDays?: number;
    poolName?: string;
  }): Promise<{ pool: PublicKey; poolSeed: anchor.BN; poolVault: PublicKey }> {
    const poolSeed = nextPoolSeed();
    const pool = derivePool(params.operator.publicKey, poolSeed);
    const poolVault = getAssociatedTokenAddressSync(usdcMint, pool, true);

    await program.methods
      .createPool(
        poolSeed,
        encodePoolName(params.poolName ?? "timelock-pool"),
        params.rateBps ?? 1_200,
        toBn(params.capacity ?? 5_000_000_000n),
        toBn(params.minimumDeposit ?? 100_000n),
        params.withdrawalQueueEnabled ?? false,
        params.allowedLoanType ?? 0,
        params.minLtvBps ?? 0,
        params.maxTermDays ?? 0,
      )
      .accounts({
        operator: params.operator.publicKey,
        operatorAuth: params.operatorAuth,
        pool,
        poolVault,
        state: statePda,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([params.operator])
      .rpc();

    return { pool, poolSeed, poolVault };
  }

  async function proposePoolChanges(params: {
    operator: Keypair;
    pool: PublicKey;
    pendingChange: PublicKey;
    rateBps?: number | null;
    capacity?: anchor.BN | null;
    minimumDeposit?: anchor.BN | null;
    allowedLoanType?: number | null;
    minLtvBps?: number | null;
    maxTermDays?: number | null;
    withdrawalQueueEnabled?: boolean | null;
  }): Promise<void> {
    await program.methods
      .proposePoolChanges(
        params.rateBps ?? null,
        params.capacity ?? null,
        params.minimumDeposit ?? null,
        params.allowedLoanType ?? null,
        params.minLtvBps ?? null,
        params.maxTermDays ?? null,
        params.withdrawalQueueEnabled ?? null,
      )
      .accounts({
        operator: params.operator.publicKey,
        pool: params.pool,
        pendingChange: params.pendingChange,
        systemProgram: SystemProgram.programId,
      })
      .signers([params.operator])
      .rpc();
  }

  before(async () => {
    await ensureStateInitialized();
    usdcMint = await createMint(connection, payer, provider.wallet.publicKey, null, 6);
  });

  after(async () => {
    await refundTrackedKeypairs(connection);
  });

  it("proposes a pending pool change with correct timelock and fields", async () => {
    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.2);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({ operator, operatorAuth });
    const pendingChange = derivePendingPoolChange(pool);

    await proposePoolChanges({
      operator,
      pool,
      pendingChange,
      rateBps: 1_450,
      capacity: toBn(7_500_000_000n),
      minimumDeposit: toBn(250_000n),
      allowedLoanType: 2,
      minLtvBps: 11_000,
      maxTermDays: 120,
      withdrawalQueueEnabled: true,
    });

    const pending = await program.account.pendingPoolChange.fetch(pendingChange);
    assert.ok((pending.pool as PublicKey).equals(pool));
    assert.ok((pending.operator as PublicKey).equals(operator.publicKey));
    assert.equal(pending.rateBps, 1_450);
    assert.equal((pending.capacity as anchor.BN).toString(), toBn(7_500_000_000n).toString());
    assert.equal((pending.minimumDeposit as anchor.BN).toString(), toBn(250_000n).toString());
    assert.equal(pending.allowedLoanType, 2);
    assert.equal(pending.minLtvBps, 11_000);
    assert.equal(pending.maxTermDays, 120);
    assert.equal(pending.withdrawalQueueEnabled, true);
    assert.equal(
      (pending.effectiveAt as anchor.BN).sub(pending.proposedAt as anchor.BN).toNumber(),
      POOL_CHANGE_TIMELOCK_SECONDS,
    );
  });

  it("rejects propose_pool_changes when signer is not pool operator", async () => {
    const operator = Keypair.generate();
    const attacker = Keypair.generate();
    await airdropSol(connection, operator, 0.2);
    await airdropSol(connection, attacker, 0.2);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({ operator, operatorAuth });
    const pendingChange = derivePendingPoolChange(pool);

    await expectTxFailure(
      program.methods
        .proposePoolChanges(1_333, null, null, null, null, null, null)
        .accounts({
          operator: attacker.publicKey,
          pool,
          pendingChange,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc(),
      "InvalidPoolOperator",
    );
  });

  it("rejects propose_pool_changes when all proposal fields are None", async () => {
    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.2);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({ operator, operatorAuth });
    const pendingChange = derivePendingPoolChange(pool);

    await expectTxFailure(
      program.methods
        .proposePoolChanges(null, null, null, null, null, null, null)
        .accounts({
          operator: operator.publicKey,
          pool,
          pendingChange,
          systemProgram: SystemProgram.programId,
        })
        .signers([operator])
        .rpc(),
      "NoChangesProposed",
    );
  });

  it("rejects duplicate proposals while a pending change exists", async () => {
    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.2);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({ operator, operatorAuth });
    const pendingChange = derivePendingPoolChange(pool);

    await proposePoolChanges({
      operator,
      pool,
      pendingChange,
      rateBps: 1_111,
    });

    await expectTxFailure(
      proposePoolChanges({
        operator,
        pool,
        pendingChange,
        rateBps: 1_222,
      }),
    );
  });

  it("applies pending changes after timelock and closes pending PDA", async function () {
    if (!canWarpClock) return this.skip();
    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.2);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({
      operator,
      operatorAuth,
      rateBps: 1_000,
      capacity: 9_000_000_000n,
      minimumDeposit: 200_000n,
      withdrawalQueueEnabled: false,
      allowedLoanType: 0,
      minLtvBps: 0,
      maxTermDays: 0,
    });
    const pendingChange = derivePendingPoolChange(pool);

    await proposePoolChanges({
      operator,
      pool,
      pendingChange,
      rateBps: 1_350,
      capacity: toBn(10_500_000_000n),
      minimumDeposit: toBn(300_000n),
      allowedLoanType: 1,
      minLtvBps: 10_900,
      maxTermDays: 180,
      withdrawalQueueEnabled: true,
    });

    const pendingBeforeApply = await program.account.pendingPoolChange.fetch(pendingChange);
    const effectiveAt = (pendingBeforeApply.effectiveAt as anchor.BN).toNumber();
    const operatorBalanceBeforeApply = await connection.getBalance(operator.publicKey, "confirmed");

    await advanceClockToTimestamp(effectiveAt);

    await program.methods
      .applyPoolChanges()
      .accounts({
        operator: operator.publicKey,
        pool,
        pendingChange,
      })
      .signers([operator])
      .rpc();

    const updatedPool = await program.account.poolState.fetch(pool);
    assert.equal(updatedPool.rateBps, 1_350);
    assert.equal(updatedPool.capacity.toString(), toBn(10_500_000_000n).toString());
    assert.equal(updatedPool.minimumDeposit.toString(), toBn(300_000n).toString());
    assert.equal(updatedPool.allowedLoanType, 1);
    assert.equal(updatedPool.minLtvBps, 10_900);
    assert.equal(updatedPool.maxTermDays, 180);
    assert.equal(updatedPool.withdrawalQueueEnabled, true);

    await waitForAccountClosure(pendingChange);

    const operatorBalanceAfterApply = await connection.getBalance(operator.publicKey, "confirmed");
    assert.isAbove(
      operatorBalanceAfterApply,
      operatorBalanceBeforeApply,
      "closing pending change PDA should refund rent to operator",
    );
  });

  it("enforces timelock boundaries (before expiry fails, at expiry succeeds)", async function () {
    if (!canWarpClock) return this.skip();
    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.2);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({ operator, operatorAuth });
    const pendingChange = derivePendingPoolChange(pool);

    await proposePoolChanges({
      operator,
      pool,
      pendingChange,
      rateBps: 1_410,
    });

    const pending = await program.account.pendingPoolChange.fetch(pendingChange);
    const effectiveAt = (pending.effectiveAt as anchor.BN).toNumber();

    await expectTxFailure(
      program.methods
        .applyPoolChanges()
        .accounts({
          operator: operator.publicKey,
          pool,
          pendingChange,
        })
        .signers([operator])
        .rpc(),
      "TimelockNotExpired",
    );

    await advanceClockToTimestamp(effectiveAt - 120);
    let currentTs = await getClockUnixTimestamp();
    while (currentTs < effectiveAt - 1) {
      await warpForwardSlots(1);
      currentTs = await getClockUnixTimestamp();
    }
    assert.isAtMost(currentTs, effectiveAt - 1);

    await expectTxFailure(
      program.methods
        .applyPoolChanges()
        .accounts({
          operator: operator.publicKey,
          pool,
          pendingChange,
        })
        .signers([operator])
        .rpc(),
      "TimelockNotExpired",
    );

    while (currentTs < effectiveAt) {
      await warpForwardSlots(1);
      currentTs = await getClockUnixTimestamp();
    }
    assert.isAtLeast(currentTs, effectiveAt);

    await program.methods
      .applyPoolChanges()
      .accounts({
        operator: operator.publicKey,
        pool,
        pendingChange,
      })
      .signers([operator])
      .rpc();
  });

  it("cancels a pending proposal and leaves pool unchanged", async () => {
    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.2);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({
      operator,
      operatorAuth,
      rateBps: 1_275,
      allowedLoanType: 0,
      maxTermDays: 30,
    });
    const pendingChange = derivePendingPoolChange(pool);

    const poolBeforeCancel = await program.account.poolState.fetch(pool);

    await proposePoolChanges({
      operator,
      pool,
      pendingChange,
      rateBps: 1_900,
      maxTermDays: 365,
      allowedLoanType: 2,
    });

    await program.methods
      .cancelPoolChanges()
      .accounts({
        operator: operator.publicKey,
        pendingChange,
      })
      .signers([operator])
      .rpc();

    await waitForAccountClosure(pendingChange);

    const poolAfterCancel = await program.account.poolState.fetch(pool);
    assert.equal(poolAfterCancel.rateBps, poolBeforeCancel.rateBps);
    assert.equal(poolAfterCancel.allowedLoanType, poolBeforeCancel.allowedLoanType);
    assert.equal(poolAfterCancel.maxTermDays, poolBeforeCancel.maxTermDays);
  });

  it("rejects cancel_pool_changes from non-operator", async () => {
    const operator = Keypair.generate();
    const attacker = Keypair.generate();
    await airdropSol(connection, operator, 0.2);
    await airdropSol(connection, attacker, 0.2);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({ operator, operatorAuth });
    const pendingChange = derivePendingPoolChange(pool);

    await proposePoolChanges({
      operator,
      pool,
      pendingChange,
      rateBps: 1_222,
    });

    await expectTxFailure(
      program.methods
        .cancelPoolChanges()
        .accounts({
          operator: attacker.publicKey,
          pendingChange,
        })
        .signers([attacker])
        .rpc(),
      "InvalidPoolOperator",
    );
  });

  it("allows proposing again after a cancel frees the PDA slot", async () => {
    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.2);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({ operator, operatorAuth });
    const pendingChange = derivePendingPoolChange(pool);

    await proposePoolChanges({
      operator,
      pool,
      pendingChange,
      rateBps: 1_050,
    });

    await program.methods
      .cancelPoolChanges()
      .accounts({
        operator: operator.publicKey,
        pendingChange,
      })
      .signers([operator])
      .rpc();

    await proposePoolChanges({
      operator,
      pool,
      pendingChange,
      rateBps: 1_065,
      withdrawalQueueEnabled: true,
    });

    const pending = await program.account.pendingPoolChange.fetch(pendingChange);
    assert.equal(pending.rateBps, 1_065);
    assert.equal(pending.withdrawalQueueEnabled, true);
  });

  it("applies partial updates without mutating untouched pool fields", async function () {
    if (!canWarpClock) return this.skip();
    const operator = Keypair.generate();
    await airdropSol(connection, operator, 0.2);
    const operatorAuth = await authorizeOperator(operator);
    const { pool } = await createPoolForOperator({
      operator,
      operatorAuth,
      rateBps: 1_180,
      capacity: 8_000_000_000n,
      minimumDeposit: 120_000n,
      withdrawalQueueEnabled: false,
      allowedLoanType: 0,
      minLtvBps: 10_700,
      maxTermDays: 45,
    });
    const pendingChange = derivePendingPoolChange(pool);
    const before = await program.account.poolState.fetch(pool);

    await proposePoolChanges({
      operator,
      pool,
      pendingChange,
      allowedLoanType: 2,
      maxTermDays: 180,
    });

    const pending = await program.account.pendingPoolChange.fetch(pendingChange);
    await advanceClockToTimestamp((pending.effectiveAt as anchor.BN).toNumber());

    await program.methods
      .applyPoolChanges()
      .accounts({
        operator: operator.publicKey,
        pool,
        pendingChange,
      })
      .signers([operator])
      .rpc();

    const after = await program.account.poolState.fetch(pool);
    assert.equal(after.allowedLoanType, 2);
    assert.equal(after.maxTermDays, 180);
    assert.equal(after.rateBps, before.rateBps);
    assert.equal(after.capacity.toString(), before.capacity.toString());
    assert.equal(after.minimumDeposit.toString(), before.minimumDeposit.toString());
    assert.equal(after.minLtvBps, before.minLtvBps);
    assert.equal(after.withdrawalQueueEnabled, before.withdrawalQueueEnabled);
  });
});
