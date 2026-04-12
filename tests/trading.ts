import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";

describe("Trading Operations", () => {
  const fallbackProgramId = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
  const programId = new PublicKey(
    process.env.STENDAR_PROGRAM_ID ?? process.env.SOLANA_PROGRAM_ID ?? fallbackProgramId,
  );

  it("derives deterministic listing PDAs from contribution + nonce", () => {
    const contribution = new PublicKey(new Uint8Array(32).fill(11));
    const nonce = 7;

    const [firstListingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), contribution.toBuffer(), Buffer.from([nonce])],
      programId,
    );
    const [secondListingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), contribution.toBuffer(), Buffer.from([nonce])],
      programId,
    );
    const [differentNoncePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), contribution.toBuffer(), Buffer.from([nonce + 1])],
      programId,
    );

    assert.equal(firstListingPda.toBase58(), secondListingPda.toBase58());
    assert.notEqual(firstListingPda.toBase58(), differentNoncePda.toBase58());  });

  it("derives deterministic offer PDAs from listing + buyer + nonce", () => {
    const listing = new PublicKey(new Uint8Array(32).fill(22));
    const buyer = new PublicKey(new Uint8Array(32).fill(33));
    const nonce = 3;

    const [firstOfferPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("offer"),
        listing.toBuffer(),
        buyer.toBuffer(),
        Buffer.from([nonce]),
      ],
      programId,
    );
    const [secondOfferPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("offer"),
        listing.toBuffer(),
        buyer.toBuffer(),
        Buffer.from([nonce]),
      ],
      programId,
    );
    const [differentBuyerPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("offer"),
        listing.toBuffer(),
        new PublicKey(new Uint8Array(32).fill(44)).toBuffer(),
        Buffer.from([nonce]),
      ],
      programId,
    );

    assert.equal(firstOfferPda.toBase58(), secondOfferPda.toBase58());
    assert.notEqual(firstOfferPda.toBase58(), differentBuyerPda.toBase58());
  });
});
