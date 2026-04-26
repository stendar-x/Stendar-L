import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { Stendar } from "../../../target/types/stendar";
import { Stendar } from "../../../target/types/stendar";
import { expect } from "chai";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";

describe("Treasury Unit Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Stendar as Program<Stendar>;
  
  const authority = Keypair.generate();
  const borrower = Keypair.generate();
  const testUser = Keypair.generate();
  
  let statePda: PublicKey;
  let treasuryPda: PublicKey;
  
  before(async () => {
    await provider.connection.requestAirdrop(authority.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(borrower.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(testUser.publicKey, 5 * LAMPORTS_PER_SOL);
    
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
  });

  describe("Treasury Account Structure", () => {
    it("Initializes with correct default values", async () => {
      const treasury = await program.account.treasury.fetch(treasuryPda);
      
      expect(treasury.authority.toString()).to.equal(authority.publicKey.toString());
      expect(treasury.totalFeesCollected.toNumber()).to.equal(0);
      expect(treasury.totalTxCosts.toNumber()).to.equal(0);
      expect(treasury.automatedOperations.toNumber()).to.equal(0);
      expect(treasury.createdAt.toNumber()).to.be.greaterThan(0);
      expect(treasury.lastOperation.toNumber()).to.equal(0);
    });

    it("Prevents duplicate treasury initialization", async () => {
      try {
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
        
        expect.fail("Should have thrown an error for duplicate initialization");
      } catch (error) {
        expect(error.message).to.include("already in use");
      }
    });
  });

  describe("Fee Collection Integration", () => {
    it("Collects listing fees during contract creation", async () => {
      const contractSeed = new anchor.BN(2);
      const [contractPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("debt_contract"), borrower.publicKey.toBuffer(), contractSeed.toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const treasuryBalanceBefore = await provider.connection.getBalance(treasuryPda);
      const borrowerBalanceBefore = await provider.connection.getBalance(borrower.publicKey);

      await program.methods
        .createDebtContract(
          contractSeed,
          new anchor.BN(100 * LAMPORTS_PER_SOL),
          new anchor.BN(1000), // 10%
          30, // 30 days
          new anchor.BN(150 * LAMPORTS_PER_SOL),
          { demand: {} },
          new anchor.BN(15000),
          { outstandingBalance: {} },
          { noFixedPayment: {} },
          { daily: {} },
          null
        )
        .accounts({
          contract: contractPda,
          state: statePda,
          treasury: treasuryPda,
          borrower: borrower.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([borrower])
        .rpc();

      const treasuryBalanceAfter = await provider.connection.getBalance(treasuryPda);
      const treasury = await program.account.treasury.fetch(treasuryPda);

      const expectedFee = 0.1 * LAMPORTS_PER_SOL;
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedFee);
      expect(treasury.totalFeesCollected.toNumber()).to.equal(expectedFee);
    });
  });

  describe("Treasury Withdrawal Functions", () => {
    it("Processes valid withdrawal requests", async () => {
      const withdrawAmount = new anchor.BN(50000000); // 0.05 SOL
      const recipientBalanceBefore = await provider.connection.getBalance(testUser.publicKey);
      
      await program.methods
        .withdrawFromTreasury(withdrawAmount)
        .accounts({
          treasury: treasuryPda,
          authority: authority.publicKey,
          recipient: testUser.publicKey,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([authority])
        .rpc();

      const recipientBalanceAfter = await provider.connection.getBalance(testUser.publicKey);
      const balanceIncrease = recipientBalanceAfter - recipientBalanceBefore;
      
      expect(balanceIncrease).to.equal(withdrawAmount.toNumber());
    });

    it("Validates withdrawal amounts", async () => {
      const treasuryBalance = await provider.connection.getBalance(treasuryPda);
      const invalidAmount = new anchor.BN(treasuryBalance + 1000000);

      try {
        await program.methods
          .withdrawFromTreasury(invalidAmount)
          .accounts({
            treasury: treasuryPda,
            authority: authority.publicKey,
            recipient: testUser.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([authority])
          .rpc();
        
        expect.fail("Should have thrown an error for invalid amount");
      } catch (error) {
        expect(error.message).to.include("insufficient");
      }
    });

    it("Rejects zero withdrawals", async () => {
      const zeroAmount = new anchor.BN(0);

      try {
        await program.methods
          .withdrawFromTreasury(zeroAmount)
          .accounts({
            treasury: treasuryPda,
            authority: authority.publicKey,
            recipient: testUser.publicKey,
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

  describe("Security and Access Control", () => {
    it("Validates treasury PDA correctly", async () => {
      const [derivedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("treasury")],
        program.programId
      );
      
      expect(treasuryPda.toString()).to.equal(derivedPda.toString());
    });

    it("Enforces authority-only access", async () => {
      const withdrawAmount = new anchor.BN(1000000);

      try {
        await program.methods
          .withdrawFromTreasury(withdrawAmount)
          .accounts({
            treasury: treasuryPda,
            authority: testUser.publicKey,
            recipient: testUser.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([testUser])
          .rpc();
        
        expect.fail("Should have thrown an error for unauthorized access");
      } catch (error) {
        expect(error.message).to.include("unauthorized");
      }
    });

    it("Prevents fake treasury account usage", async () => {
      const fakeTreasury = Keypair.generate();
      const withdrawAmount = new anchor.BN(1000000);

      try {
        await program.methods
          .withdrawFromTreasury(withdrawAmount)
          .accounts({
            treasury: fakeTreasury.publicKey,
            authority: authority.publicKey,
            recipient: testUser.publicKey,
            systemProgram: SystemProgram.programId,
          } as any)
          .signers([authority])
          .rpc();
        
        expect.fail("Should have thrown an error for fake treasury");
      } catch (error) {
        expect(error.message).to.include("account");
      }
    });
  });
}); 