import { assert } from "chai";
import { PublicKey } from "@solana/web3.js";

describe("Trading Integration Tests", () => {
  const fallbackProgramId = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
  const programId = new PublicKey(
    process.env.STENDAR_PROGRAM_ID ?? process.env.SOLANA_PROGRAM_ID ?? fallbackProgramId,
  );

  it("keeps listing -> offer PDA derivations consistent across clients", () => {
    const contribution = new PublicKey(new Uint8Array(32).fill(55));
    const seller = new PublicKey(new Uint8Array(32).fill(66));
    const buyer = new PublicKey(new Uint8Array(32).fill(77));
    const nonce = 1;

    const [listingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), contribution.toBuffer(), Buffer.from([nonce])],
      programId,
    );
    const [offerPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("offer"),
        listingPda.toBuffer(),
        buyer.toBuffer(),
        Buffer.from([nonce]),
      ],
      programId,
    );

    assert.notEqual(listingPda.toBase58(), offerPda.toBase58());

    const [listingPdaRepeated] = PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), contribution.toBuffer(), Buffer.from([nonce])],
      programId,
    );
    const [offerPdaRepeated] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("offer"),
        listingPdaRepeated.toBuffer(),
        buyer.toBuffer(),
        Buffer.from([nonce]),
      ],
      programId,
    );

    assert.equal(listingPda.toBase58(), listingPdaRepeated.toBase58());
    assert.equal(offerPda.toBase58(), offerPdaRepeated.toBase58());
    assert.notEqual(listingPda.toBase58(), seller.toBase58());  });

  it("changes offer PDA when nonce changes", () => {
    const listing = new PublicKey(new Uint8Array(32).fill(88));
    const buyer = new PublicKey(new Uint8Array(32).fill(99));

    const [offerNonce0] = PublicKey.findProgramAddressSync(
      [Buffer.from("offer"), listing.toBuffer(), buyer.toBuffer(), Buffer.from([0])],
      programId,
    );
    const [offerNonce1] = PublicKey.findProgramAddressSync(
      [Buffer.from("offer"), listing.toBuffer(), buyer.toBuffer(), Buffer.from([1])],
      programId,
    );

    assert.notEqual(offerNonce0.toBase58(), offerNonce1.toBase58());
  });
});
