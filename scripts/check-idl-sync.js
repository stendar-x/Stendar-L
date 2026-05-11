const fs = require("fs");
const path = require("path");

const CANONICAL_IDL_RELATIVE_PATH = path.join("target", "idl", "stendar.json");
const SDK_IDL_RELATIVE_PATH = path.join("sdk", "src", "idl", "stendar.json");

function normalize(content) {
  return content.replace(/\r\n/g, "\n").trimEnd();
}

function readOrThrow(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing IDL file: ${filePath}`);
  }
  return normalize(fs.readFileSync(filePath, "utf8"));
}

function getIdlPaths(repoRoot = path.resolve(__dirname, "..")) {
  return {
    repoRoot,
    canonicalPath: path.join(repoRoot, CANONICAL_IDL_RELATIVE_PATH),
    sdkIdlPath: path.join(repoRoot, SDK_IDL_RELATIVE_PATH),
  };
}

function checkIdlSync(options = {}) {
  const ifPresent = options.ifPresent ?? false;
  const log = options.log ?? console.log;
  const { repoRoot, canonicalPath, sdkIdlPath } = getIdlPaths(options.repoRoot);

  if (!fs.existsSync(canonicalPath)) {
    if (ifPresent) {
      log(
        "Skipping IDL sync check because target/idl/stendar.json is missing. Run `anchor build` first, then rerun `npm run idl:check` for strict verification."
      );
      return {
        status: "skipped",
        reason: "missing-canonical-idl",
        canonicalPath,
        sdkIdlPath,
      };
    }

    throw new Error(
      [
        `Missing IDL file: ${canonicalPath}`,
        "Run `anchor build` first, then rerun `npm run idl:check`.",
      ].join(" ")
    );
  }

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

  log("SDK IDL is in sync with target/idl/stendar.json");
  return {
    status: "matched",
    canonicalPath,
    sdkIdlPath,
  };
}

function parseCliArgs(argv = process.argv.slice(2)) {
  return {
    ifPresent: argv.includes("--if-present"),
  };
}

if (require.main === module) {
  const cliArgs = parseCliArgs();
  checkIdlSync({ ifPresent: cliArgs.ifPresent });
}

module.exports = {
  CANONICAL_IDL_RELATIVE_PATH,
  SDK_IDL_RELATIVE_PATH,
  normalize,
  readOrThrow,
  getIdlPaths,
  checkIdlSync,
  parseCliArgs,
};
