import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { createMint, NATIVE_MINT } from "@solana/spl-token";
import { assert } from "chai";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import type { Stendar } from "../target/types/stendar.ts";

import { airdropSol, refundTrackedKeypairs } from "./test_helpers.ts";

const PYTH_RECEIVER_PROGRAM_ID = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
);
const MOCK_PYTH_ACCOUNT_SPACE = 128;

function parseAnchorError(error: unknown): string {
  const anyErr = error as any;
  return (
    anyErr?.error?.errorCode?.code ??
    anyErr?.error?.errorMessage ??
    anyErr?.logs?.join(" ") ??
    anyErr?.toString?.() ??
    String(error)
  );
}

function findCollateralTypeByMint(registry: any, mint: PublicKey): any | undefined {
  return registry.collateralTypes.find((entry: any) => entry.mint.equals(mint));
}

describe("Collateral registry admin", () => {
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
  ) as Program<Stendar> & any;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet & { payer: Keypair }).payer;
  const hasMockOracleInstructions =
    typeof (program.methods as any).initializeMockOraclePriceFeed === "function";

  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_state")],
    program.programId,
  );
  const [registryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("collateral_registry")],
    program.programId,
  );

  function toBn(value: bigint | number): anchor.BN {
    return new anchor.BN(value.toString());
  }

  function mockOraclePda(feedSeed: anchor.BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("mock_oracle_price_feed"), feedSeed.toArrayLike(Buffer, "le", 8)],
      program.programId,
    )[0];
  }

  async function upsertMockOraclePriceFeed(
    feedSeed: anchor.BN,
    price: bigint,
    exponent = -8,
  ): Promise<PublicKey> {
    const feedPda = mockOraclePda(feedSeed);
    const accountInfo = await connection.getAccountInfo(feedPda);
    const now = Math.floor(Date.now() / 1000);

    if (accountInfo === null) {
      await program.methods
        .initializeMockOraclePriceFeed(feedSeed, toBn(price), exponent, toBn(now))
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: feedPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else if (typeof (program.methods as any).setMockOraclePriceFeed === "function") {
      await program.methods
        .setMockOraclePriceFeed(toBn(price), exponent, toBn(now))
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          mockOraclePriceFeed: feedPda,
        })
        .rpc();
    }

    return feedPda;
  }

  async function ensurePlatformInitialized(): Promise<void> {
    const stateInfo = await connection.getAccountInfo(statePda);
    if (!stateInfo) {
      await program.methods
        .initialize()
        .accounts({
          state: statePda,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  }

  async function createTestMint(decimals: number): Promise<PublicKey> {
    return createMint(
      connection,
      payer,
      provider.wallet.publicKey,
      null,
      decimals,
    );
  }

  async function fetchRegistry(): Promise<any> {
    return program.account.collateralRegistry.fetch(registryPda);
  }

  async function createMockPythPriceFeedAccount(): Promise<PublicKey> {
    const oracle = Keypair.generate();
    const lamports = await connection.getMinimumBalanceForRentExemption(
      MOCK_PYTH_ACCOUNT_SPACE,
    );
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: oracle.publicKey,
        lamports,
        space: MOCK_PYTH_ACCOUNT_SPACE,
        programId: PYTH_RECEIVER_PROGRAM_ID,
      }),
    );
    await provider.sendAndConfirm(tx, [oracle]);
    return oracle.publicKey;
  }

  let wbtcMint: PublicKey;
  let wethMint: PublicKey;
  let msolMint: PublicKey;
  let wsolMint: PublicKey;
  let oracleSeed = Math.floor(Date.now() / 1000) * 1_000;
  const nextOracleSeed = (): anchor.BN => {
    oracleSeed += 1;
    return new anchor.BN(oracleSeed);
  };

  let wbtcOracle: PublicKey;
  let wethOracle: PublicKey;
  let msolOracle: PublicKey;
  let wsolOracle: PublicKey;

  before(async function () {
    if (!hasMockOracleInstructions) return this.skip();
    await ensurePlatformInitialized();
    wbtcMint = await createTestMint(8);
    wethMint = await createTestMint(8);
    msolMint = await createTestMint(9);
    wsolMint = NATIVE_MINT;
    wbtcOracle = await upsertMockOraclePriceFeed(nextOracleSeed(), 250_000_000_000n);
    wethOracle = await upsertMockOraclePriceFeed(nextOracleSeed(), 260_000_000_000n);
    msolOracle = await upsertMockOraclePriceFeed(nextOracleSeed(), 240_000_000_000n);
    wsolOracle = await upsertMockOraclePriceFeed(nextOracleSeed(), 255_000_000_000n);
  });

  after(async () => {
    await refundTrackedKeypairs(connection);
  });

  it("Initializes registry and stores authority", async () => {
    const existingRegistry = await connection.getAccountInfo(registryPda, "confirmed");
    if (existingRegistry === null) {
      await program.methods
        .initializeCollateralRegistry()
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: registryPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    await (program as any).methods
      .resetCollateralRegistry()
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        collateralRegistry: registryPda,
      })
      .rpc();

    const registry = await fetchRegistry();
    assert.ok(registry.authority.equals(provider.wallet.publicKey));
    assert.equal(registry.numCollateralTypes, 0);
  });

  it("Adds wBTC collateral and increments count", async () => {
    const registryBefore = await fetchRegistry();
    const countBefore = registryBefore.numCollateralTypes;

    await program.methods
      .addCollateralType(wbtcOracle, 8, 600, 11_000)
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        collateralRegistry: registryPda,
        collateralMint: wbtcMint,
        oraclePriceFeed: wbtcOracle,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const registry = await fetchRegistry();
    const wbtc = findCollateralTypeByMint(registry, wbtcMint);

    assert.isDefined(wbtc);
    assert.equal(registry.numCollateralTypes, countBefore + 1);
    assert.ok(wbtc.mint.equals(wbtcMint));
    assert.ok(wbtc.oraclePriceFeed.equals(wbtcOracle));
    assert.equal(wbtc.decimals, 8);
    assert.equal(wbtc.liquidationBufferBps, 600);
    assert.equal(wbtc.minCommittedFloorBps, 11_000);
    assert.isTrue(wbtc.isActive);
  });

  it("Adds multiple collateral types", async () => {
    await program.methods
      .addCollateralType(wethOracle, 8, 700, 11_250)
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        collateralRegistry: registryPda,
        collateralMint: wethMint,
        oraclePriceFeed: wethOracle,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .addCollateralType(wsolOracle, 9, 500, 11_000)
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        collateralRegistry: registryPda,
        collateralMint: wsolMint,
        oraclePriceFeed: wsolOracle,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .addCollateralType(msolOracle, 9, 850, 11_500)
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        collateralRegistry: registryPda,
        collateralMint: msolMint,
        oraclePriceFeed: msolOracle,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const registry = await fetchRegistry();
    assert.isDefined(findCollateralTypeByMint(registry, wethMint));
    assert.isDefined(findCollateralTypeByMint(registry, wsolMint));
    assert.isDefined(findCollateralTypeByMint(registry, msolMint));
    assert.isDefined(findCollateralTypeByMint(registry, wbtcMint));
    assert.isDefined(findCollateralTypeByMint(registry, wethMint));
    assert.isDefined(findCollateralTypeByMint(registry, wsolMint));
    assert.isDefined(findCollateralTypeByMint(registry, msolMint));
  });

  it("Rejects duplicate collateral mint", async () => {
    try {
      await program.methods
        .addCollateralType(wethOracle, 8, 650, 11_000)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: registryPda,
          collateralMint: wbtcMint,
          oraclePriceFeed: wethOracle,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("expected duplicate collateral add to fail");
    } catch (error) {
      assert.match(parseAnchorError(error), /CollateralTypeAlreadyExists/);
    }
  });

  it("Rejects oracle account/key mismatch during registration", async () => {
    const mint = await createTestMint(6);
    const mismatchedOracle = Keypair.generate().publicKey;

    try {
      await program.methods
        .addCollateralType(mismatchedOracle, 6, 500, 10_500)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: registryPda,
          collateralMint: mint,
          oraclePriceFeed: wbtcOracle,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("expected mismatched oracle registration to fail");
    } catch (error) {
      assert.match(parseAnchorError(error), /OraclePriceFeedMismatch/);
    }
  });

  it("Updates only the liquidation buffer for a collateral type", async () => {
    const before = await fetchRegistry();
    const beforeWbtc = findCollateralTypeByMint(before, wbtcMint);
    assert.isDefined(beforeWbtc);

    await program.methods
      .updateCollateralType(wbtcMint, null, 950, null)
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        collateralRegistry: registryPda,
        oraclePriceFeed: wbtcOracle,
      })
      .rpc();

    const after = await fetchRegistry();
    const afterWbtc = findCollateralTypeByMint(after, wbtcMint);
    assert.equal(afterWbtc.liquidationBufferBps, 950);
    assert.equal(
      afterWbtc.minCommittedFloorBps,
      beforeWbtc.minCommittedFloorBps,
      "floor should be unchanged when not provided",
    );
    assert.ok(
      afterWbtc.oraclePriceFeed.equals(beforeWbtc.oraclePriceFeed),
      "oracle should be unchanged when not provided",
    );
  });

  it("Supports partial oracle-only update", async () => {
    const newOracle = await upsertMockOraclePriceFeed(nextOracleSeed(), 245_000_000_000n);
    const before = await fetchRegistry();
    const beforeWbtc = findCollateralTypeByMint(before, wbtcMint);
    assert.isDefined(beforeWbtc);

    await program.methods
      .updateCollateralType(wbtcMint, newOracle, null, null)
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        collateralRegistry: registryPda,
        oraclePriceFeed: newOracle,
      })
      .rpc();

    const after = await fetchRegistry();
    const afterWbtc = findCollateralTypeByMint(after, wbtcMint);
    assert.ok(afterWbtc.oraclePriceFeed.equals(newOracle));
    assert.equal(
      afterWbtc.liquidationBufferBps,
      beforeWbtc.liquidationBufferBps,
      "buffer should be unchanged when not provided",
    );
    assert.equal(
      afterWbtc.minCommittedFloorBps,
      beforeWbtc.minCommittedFloorBps,
      "floor should be unchanged when not provided",
    );
  });

  it("Deactivates collateral without removing it from the registry", async () => {
    const before = await fetchRegistry();
    const beforeLen = before.collateralTypes.length;

    await program.methods
      .deactivateCollateralType(wbtcMint)
      .accounts({
        authority: provider.wallet.publicKey,
        state: statePda,
        collateralRegistry: registryPda,
      })
      .rpc();

    const after = await fetchRegistry();
    const afterWbtc = findCollateralTypeByMint(after, wbtcMint);
    assert.isDefined(afterWbtc);
    assert.isFalse(afterWbtc.isActive);
    assert.equal(after.collateralTypes.length, beforeLen);
  });

  it("Rejects non-authority add/update/deactivate operations", async () => {
    const attacker = Keypair.generate();
    await airdropSol(connection, attacker, 0.01);
    const attackerMint = await createTestMint(6);

    try {
      await program.methods
        .addCollateralType(wbtcOracle, 6, 500, 10_500)
        .accounts({
          authority: attacker.publicKey,
          state: statePda,
          collateralRegistry: registryPda,
          collateralMint: attackerMint,
          oraclePriceFeed: wbtcOracle,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      assert.fail("expected unauthorized add to fail");
    } catch (error) {
      assert.match(parseAnchorError(error), /InvalidAuthority|UnauthorizedAuthorityUpdate/);
    }

    try {
      await program.methods
        .updateCollateralType(wethMint, null, 1_000, null)
        .accounts({
          authority: attacker.publicKey,
          state: statePda,
          collateralRegistry: registryPda,
          oraclePriceFeed: wethOracle,
        })
        .signers([attacker])
        .rpc();
      assert.fail("expected unauthorized update to fail");
    } catch (error) {
      assert.match(parseAnchorError(error), /InvalidAuthority|UnauthorizedAuthorityUpdate/);
    }

    try {
      await program.methods
        .deactivateCollateralType(wethMint)
        .accounts({
          authority: attacker.publicKey,
          state: statePda,
          collateralRegistry: registryPda,
        })
        .signers([attacker])
        .rpc();
      assert.fail("expected unauthorized deactivate to fail");
    } catch (error) {
      assert.match(parseAnchorError(error), /InvalidAuthority|UnauthorizedAuthorityUpdate/);
    }
  });

  it("find_collateral_type helper behavior maps correctly off-chain", async () => {
    const registry = await fetchRegistry();

    const known = findCollateralTypeByMint(registry, wethMint);
    assert.isDefined(known);
    assert.ok(known!.mint.equals(wethMint));

    const unknown = findCollateralTypeByMint(registry, Keypair.generate().publicKey);
    assert.isUndefined(unknown);
  });

  it("Enforces the 20-entry capacity limit", async () => {
    let registry = await fetchRegistry();
    const remainingSlots = 20 - registry.collateralTypes.length;

    for (let i = 0; i < remainingSlots; i += 1) {
      const mint = await createTestMint(6);
      const oracle = await upsertMockOraclePriceFeed(nextOracleSeed(), 230_000_000_000n + BigInt(i));
      await program.methods
        .addCollateralType(oracle, 6, 500 + (i % 50), 10_500)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: registryPda,
          collateralMint: mint,
          oraclePriceFeed: oracle,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    registry = await fetchRegistry();
    assert.equal(registry.collateralTypes.length, 20);
    assert.equal(registry.numCollateralTypes, 20);

    const overflowMint = await createTestMint(6);
    const overflowOracle = await upsertMockOraclePriceFeed(nextOracleSeed(), 229_999_999_999n);
    try {
      await program.methods
        .addCollateralType(overflowOracle, 6, 550, 10_500)
        .accounts({
          authority: provider.wallet.publicKey,
          state: statePda,
          collateralRegistry: registryPda,
          collateralMint: overflowMint,
          oraclePriceFeed: overflowOracle,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("expected collateral registry capacity overflow");
    } catch (error) {
      assert.match(parseAnchorError(error), /CollateralRegistryFull/);
    }
  });
});
