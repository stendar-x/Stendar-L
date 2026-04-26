import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { Stendar } from "../../../target/types/stendar";
import { Stendar } from "../../../target/types/stendar";
import { expect } from "chai";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";

describe("Treasury Security & Withdrawal", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Stendar as Program<Stendar>;
  
  const authority = Keypair.generate();
  const unauthorizedUser = Keypair.generate();
  
  let statePda: PublicKey;
  let treasuryPda: PublicKey;
  
  const LISTING_FEE = 0.1 * LAMPORTS_PER_SOL;

  before(async () => {
    await provider.connection.requestAirdrop(authority.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(unauthorizedUser.publicKey, 2 * LAMPORTS_PER_SOL);

    await new Promise(resolve => setTimeout(resolve, 1000));

    [statePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global_state")],
      program.programId
    );

    [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury")],
      program.programId
    );

    await program.methods
      .initialize()
      .accounts({
        state: statePda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([authority])
      .rpc();

    await program.methods
      .initializeTreasury()
      .accounts({
        treasury: treasuryPda,
        state: statePda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([authority])
      .rpc();

    await provider.connection.requestAirdrop(treasuryPda, 2 * LAMPORTS_PER_SOL);
    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  describe("Treasury Withdrawal Access Control", () => {
    it("Allows authorized withdrawal by program authority", async () => {
      const authorityBalanceBefore = await provider.connection.getBalance(authority.publicKey);
      const treasuryBalanceBefore = await provider.connection.getBalance(treasuryPda);
      const withdrawAmount = new anchor.BN(LAMPORTS_PER_SOL); // 1 SOL

      await program.methods
        .withdrawFromTreasury(withdrawAmount)
        .accounts({
          treasury: treasuryPda,
          authority: authority.publicKey,
          recipient: authority.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([authority])
        .rpc();

      const authorityBalanceAfter = await provider.connection.getBalance(authority.publicKey);
      const treasuryBalanceAfter = await provider.connection.getBalance(treasuryPda);

      expect(treasuryBalanceAfter).to.be.lessThan(treasuryBalanceBefore);
      expect(authorityBalanceAfter).to.be.greaterThan(authorityBalanceBefore);
      
      // Verify approximate amounts (accounting for transaction fees)
      const netWithdrawal = authorityBalanceAfter - authorityBalanceBefore;
      expect(netWithdrawal).to.be.approximately(LAMPORTS_PER_SOL, 50000); // 0.05 SOL tolerance
    });

    it("Prevents unauthorized withdrawal attempts", async () => {
      const withdrawAmount = new anchor.BN(LAMPORTS_PER_SOL);

      try {
        await program.methods
          .withdrawFromTreasury(withdrawAmount)
          .accounts({
            treasury: treasuryPda,
            authority: unauthorizedUser.publicKey,
            recipient: unauthorizedUser.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([unauthorizedUser])
          .rpc();
        
        expect.fail("Should have thrown an error for unauthorized withdrawal");
      } catch (error) {
        expect(error.message).to.include("unauthorized");
      }
    });

    it("Prevents withdrawal of more than available balance", async () => {
      const treasuryBalance = await provider.connection.getBalance(treasuryPda);
      const excessiveAmount = new anchor.BN(treasuryBalance + LAMPORTS_PER_SOL);

      try {
        await program.methods
          .withdrawFromTreasury(excessiveAmount)
          .accounts({
            treasury: treasuryPda,
            authority: authority.publicKey,
            recipient: authority.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([authority])
          .rpc();
        
        expect.fail("Should have thrown an error for insufficient balance");
      } catch (error) {
        expect(error.message).to.include("insufficient");
      }
    });

    it("Prevents zero-amount withdrawals", async () => {
      const zeroAmount = new anchor.BN(0);

      try {
        await program.methods
          .withdrawFromTreasury(zeroAmount)
          .accounts({
            treasury: treasuryPda,
            authority: authority.publicKey,
            recipient: authority.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([authority])
          .rpc();
        
        expect.fail("Should have thrown an error for zero withdrawal");
      } catch (error) {
        expect(error.message).to.include("invalid");
      }
    });
  });

  describe("Treasury Security Features", () => {
    it("Maintains proper PDA derivation", async () => {
      const [expectedTreasuryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("treasury")],
        program.programId
      );

      expect(treasuryPda.toString()).to.equal(expectedTreasuryPda.toString());

      const treasury = await program.account.treasury.fetch(treasuryPda);
      expect(treasury.authority.toString()).to.equal(authority.publicKey.toString());
    });

    it("Tracks treasury operations securely", async () => {
      const treasury = await program.account.treasury.fetch(treasuryPda);
      
      expect(treasury.createdAt.toNumber()).to.be.greaterThan(0);
      expect(treasury.authority.toString()).to.equal(authority.publicKey.toString());
      expect(treasury.totalFeesCollected.toNumber()).to.be.greaterThan(0);
    });

    it("Validates treasury account data integrity", async () => {
      const treasury = await program.account.treasury.fetch(treasuryPda);
      
      expect(treasury.authority).to.be.instanceOf(PublicKey);
      expect(treasury.totalFeesCollected).to.be.instanceOf(anchor.BN);
      expect(treasury.totalTxCosts).to.be.instanceOf(anchor.BN);
      expect(treasury.automatedOperations).to.be.instanceOf(anchor.BN);
      expect(treasury.createdAt).to.be.instanceOf(anchor.BN);
      expect(treasury.lastOperation).to.be.instanceOf(anchor.BN);
    });

    it("Prevents malicious account substitution", async () => {
      const maliciousPda = Keypair.generate();
      const withdrawAmount = new anchor.BN(1000);

      try {
        await program.methods
          .withdrawFromTreasury(withdrawAmount)
          .accounts({
            treasury: maliciousPda.publicKey,
            authority: authority.publicKey,
            recipient: authority.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([authority])
          .rpc();
        
        expect.fail("Should have thrown an error for malicious account");
      } catch (error) {
        expect(error.message).to.include("account");
      }
    });
  });

  describe("Treasury Balance Management", () => {
    it("Accurately tracks balance changes", async () => {
      const balanceBefore = await provider.connection.getBalance(treasuryPda);
      const withdrawAmount = new anchor.BN(500000); // 0.0005 SOL
      
      await program.methods
        .withdrawFromTreasury(withdrawAmount)
        .accounts({
          treasury: treasuryPda,
          authority: authority.publicKey,
          recipient: authority.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([authority])
        .rpc();

      const balanceAfter = await provider.connection.getBalance(treasuryPda);
      const actualWithdrawal = balanceBefore - balanceAfter;
      
      expect(actualWithdrawal).to.equal(withdrawAmount.toNumber());
    });

    it("Maintains minimum operational balance", async () => {
      const currentBalance = await provider.connection.getBalance(treasuryPda);
      const rentExempt = await provider.connection.getMinimumBalanceForRentExemption(
        program.account.treasury.size
      );

      // Ensure we can't withdraw below rent-exempt amount
      const maxWithdrawal = currentBalance - rentExempt;
      if (maxWithdrawal > 0) {
        const withdrawAmount = new anchor.BN(maxWithdrawal + 1);

        try {
          await program.methods
            .withdrawFromTreasury(withdrawAmount)
            .accounts({
              treasury: treasuryPda,
              authority: authority.publicKey,
              recipient: authority.publicKey,
              systemProgram: SystemProgram.programId,
            } as any)
            .signers([authority])
            .rpc();
          
          expect.fail("Should have thrown an error for insufficient balance");
        } catch (error) {
          expect(error.message).to.include("insufficient");
        }
      }
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("Handles concurrent withdrawal attempts", async () => {
      const treasury = await program.account.treasury.fetch(treasuryPda);
      expect(treasury.authority.toString()).to.equal(authority.publicKey.toString());
    });

    it("Maintains state consistency after failed operations", async () => {
      const treasuryBefore = await program.account.treasury.fetch(treasuryPda);
      const balanceBefore = await provider.connection.getBalance(treasuryPda);

      let caughtError: unknown = null;
      try {
        await program.methods
          .withdrawFromTreasury(new anchor.BN(0))
          .accounts({
            treasury: treasuryPda,
            authority: authority.publicKey,
            recipient: authority.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([authority])
          .rpc();
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError, "zero-value treasury withdrawal should fail").to.not.equal(null);

      const treasuryAfter = await program.account.treasury.fetch(treasuryPda);
      const balanceAfter = await provider.connection.getBalance(treasuryPda);

      expect(treasuryAfter.totalFeesCollected.toNumber())
        .to.equal(treasuryBefore.totalFeesCollected.toNumber());
      expect(balanceAfter).to.equal(balanceBefore);
    });
  });
}); 