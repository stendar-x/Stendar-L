import { assert } from "chai";
import path from "path";

const {
  validateCollateralListingsUniqueness,
  validateManifestFile,
}: {
  validateCollateralListingsUniqueness: (manifest: unknown, label: string) => void;
  validateManifestFile: (filePath: string) => void;
} = require("../scripts/validate-collateral-listings.js");

describe("Collateral listing manifest uniqueness", () => {
  it("accepts current collateral listing manifests without duplicate mints", () => {
    const repoRoot = path.resolve(__dirname, "..");
    validateManifestFile(path.join(repoRoot, "security", "collateral-listings", "devnet.json"));
    validateManifestFile(path.join(repoRoot, "security", "collateral-listings", "mainnet.json"));
  });

  it("rejects manifests that contain duplicate mint entries", () => {
    const manifest = {
      manifestVersion: 1,
      environment: "devnet",
      assets: [
        { symbol: "WSOL", mint: "So11111111111111111111111111111111111111112" },
        { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
      ],
    };

    assert.throws(
      () => validateCollateralListingsUniqueness(manifest, "inline-fixture"),
      /duplicate collateral mint entries/i,
    );
  });
});
