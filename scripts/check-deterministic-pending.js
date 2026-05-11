const fs = require("fs");
const path = require("path");

const PENDING_MARKER_PATTERN = /\b(?:this|describe|it|test|context|suite|specify)\.(?:skip|only)\s*\(|\b(?:xit|xdescribe|xcontext|xspecify|xsuite)\s*\(/;

const DEFAULT_DETERMINISTIC_TEST_FILES = Object.freeze([
  "tests/trading.ts",
  "tests/integration_trading.ts",
  "tests/security_regression_static.ts",
  "tests/platform_stats_service.ts",
]);

const DOCUMENTED_ENV_GATED_SUITES = Object.freeze([
  "tests/collateral_registry.ts",
  "tests/lender_withdrawal.ts",
  "tests/lending_lifecycle.ts",
  "tests/pool_expiration.ts",
  "tests/revolving_lifecycle.ts",
  "tests/pool_lifecycle.ts",
  "tests/pool_timelock.ts",
  "tests/stendar.ts",
  "tests/stream12_testing_audit.ts",
  "tests/term_proposal_consensus.ts",
  "programs/stendar/tests/treasury-integration.ts",
  "programs/stendar/tests/treasury-operations.ts",
  "programs/stendar/tests/treasury-security.ts",
  "programs/stendar/tests/treasury-unit.ts",
]);

function stripCommentsFromLine(line, state) {
  let uncommented = "";

  for (let index = 0; index < line.length; index += 1) {
    if (state.quote) {
      const current = line[index];
      if (current === "\\") {
        index += 1;
        continue;
      }
      if (current === state.quote) {
        state.quote = null;
      }
      continue;
    }

    if (state.inBlockComment) {
      const blockEnd = line.indexOf("*/", index);
      if (blockEnd === -1) {
        return uncommented;
      }
      state.inBlockComment = false;
      index = blockEnd + 1;
      continue;
    }

    const current = line[index];
    const next = line[index + 1];

    if (current === "\"" || current === "'" || current === "`") {
      state.quote = current;
      continue;
    }

    if (current === "/" && next === "/") {
      break;
    }

    if (current === "/" && next === "*") {
      state.inBlockComment = true;
      index += 1;
      continue;
    }

    uncommented += current;
  }

  return uncommented;
}

function findPendingMarkers(fileContent) {
  const markers = [];
  const lines = fileContent.split(/\r?\n/);
  const commentState = { inBlockComment: false, quote: null };
  for (let index = 0; index < lines.length; index += 1) {
    const uncommentedLine = stripCommentsFromLine(lines[index], commentState);
    const match = uncommentedLine.match(PENDING_MARKER_PATTERN);
    if (!match) {
      continue;
    }
    markers.push({
      line: index + 1,
      marker: match[0],
    });
  }
  return markers;
}

function scanDeterministicPendingTests(options = {}) {
  const repoRoot = options.repoRoot ?? path.resolve(__dirname, "..");
  const deterministicTestFiles =
    options.deterministicTestFiles ?? DEFAULT_DETERMINISTIC_TEST_FILES;
  const existsSync = options.existsSync ?? fs.existsSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;

  const violations = [];
  for (const relativePath of deterministicTestFiles) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!existsSync(absolutePath)) {
      throw new Error(`Deterministic regression file is missing: ${relativePath}`);
    }
    const markers = findPendingMarkers(readFileSync(absolutePath, "utf8"));
    if (markers.length > 0) {
      violations.push({
        filePath: relativePath,
        markers,
      });
    }
  }

  return {
    deterministicTestFiles: [...deterministicTestFiles],
    documentedEnvGatedSuites: [...DOCUMENTED_ENV_GATED_SUITES],
    violations,
  };
}

function formatViolations(violations) {
  return violations
    .map(({ filePath, markers }) => {
      const details = markers
        .map(({ line, marker }) => `line ${line} (${marker})`)
        .join(", ");
      return `${filePath}: ${details}`;
    })
    .join("; ");
}

function runDeterministicPendingScan(options = {}) {
  const log = options.log ?? console.log;
  const result = scanDeterministicPendingTests(options);
  if (result.violations.length > 0) {
    throw new Error(
      [
        "Pending-test or exclusive-test markers are not allowed in deterministic regression suites.",
        formatViolations(result.violations),
        "Move skip logic into documented environment-gated suites instead.",
      ].join(" ")
    );
  }

  log("No pending-test markers found in deterministic regression suites.");
  log(
    [
      "Documented environment-gated suites are intentionally excluded from this check:",
      result.documentedEnvGatedSuites.join(", "),
      "These suites may use runtime this.skip() when validator/testing-feature prerequisites are unavailable.",
    ].join(" ")
  );
  return result;
}

if (require.main === module) {
  runDeterministicPendingScan();
}

module.exports = {
  DEFAULT_DETERMINISTIC_TEST_FILES,
  DOCUMENTED_ENV_GATED_SUITES,
  PENDING_MARKER_PATTERN,
  findPendingMarkers,
  stripCommentsFromLine,
  scanDeterministicPendingTests,
  runDeterministicPendingScan,
};
