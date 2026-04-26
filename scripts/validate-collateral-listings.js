#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function validateCollateralListingsUniqueness(manifest, label) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`[security] ${label}: manifest must be an object`);
  }
  if (!Array.isArray(manifest.assets)) {
    throw new Error(`[security] ${label}: assets must be an array`);
  }

  const seen = new Set();
  const duplicates = new Set();
  for (const asset of manifest.assets) {
    const mint = asset && typeof asset.mint === "string" ? asset.mint : "";
    if (mint.length === 0) {
      continue;
    }
    if (seen.has(mint)) {
      duplicates.add(mint);
    } else {
      seen.add(mint);
    }
  }

  if (duplicates.size > 0) {
    throw new Error(
      `[security] ${label}: duplicate collateral mint entries found: ${Array.from(duplicates).join(", ")}`
    );
  }
}

function validateManifestFile(filePath) {
  const manifest = readJson(filePath);
  const label = path.relative(process.cwd(), filePath);
  const expectedEnvironment = path.basename(filePath, path.extname(filePath));

  if (typeof manifest.environment !== "string" || manifest.environment.length === 0) {
    throw new Error(`[security] ${label}: environment must be a non-empty string`);
  }

  if (manifest.environment !== expectedEnvironment) {
    throw new Error(
      `[security] ${label}: environment "${manifest.environment}" does not match filename "${expectedEnvironment}"`,
    );
  }

  validateCollateralListingsUniqueness(manifest, label);
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const manifests = [
    path.join(repoRoot, "security", "collateral-listings", "devnet.json"),
    path.join(repoRoot, "security", "collateral-listings", "mainnet.json"),
  ];

  manifests.forEach(validateManifestFile);
  console.log("[security] collateral listing mint uniqueness checks passed.");
}

if (require.main === module) {
  main();
}

module.exports = {
  validateCollateralListingsUniqueness,
  validateManifestFile,
};
