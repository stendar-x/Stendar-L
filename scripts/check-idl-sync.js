const fs = require("fs");
const path = require("path");

function normalize(content) {
  return content.replace(/\r\n/g, "\n").trimEnd();
}

function readOrThrow(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing IDL file: ${filePath}`);
  }
  return normalize(fs.readFileSync(filePath, "utf8"));
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const canonicalPath = path.join(repoRoot, "target", "idl", "stendar.json");
  const sdkIdlPath = path.join(repoRoot, "sdk", "src", "idl", "stendar.json");

  const canonical = readOrThrow(canonicalPath);
  const sdkIdl = readOrThrow(sdkIdlPath);
  if (sdkIdl !== canonical) {
    throw new Error(
      [
        "IDL drift detected.",
        `Canonical: ${path.relative(repoRoot, canonicalPath)}`,
        `Mismatched copy: ${path.relative(repoRoot, sdkIdlPath)}`,
        "Regenerate with `anchor build` and sync sdk/src/idl/stendar.json.",
      ].join(" ")
    );
  }

  console.log("SDK IDL is in sync with target/idl/stendar.json");
}

main();
