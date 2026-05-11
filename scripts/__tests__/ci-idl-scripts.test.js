const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { checkIdlSync } = require("../check-idl-sync.js");
const {
  DEFAULT_DETERMINISTIC_TEST_FILES,
  DOCUMENTED_ENV_GATED_SUITES,
  findPendingMarkers,
  runDeterministicPendingScan,
  scanDeterministicPendingTests,
} = require("../check-deterministic-pending.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function withTempDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stendar-ci-idl-"));
  try {
    return callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeDeterministicRegressionFiles(
  repoRoot,
  {
    trading = "describe('trading', () => {});\n",
    integration = "describe('integration trading', () => {});\n",
    security = "describe('security regression', () => {});\n",
    platformStats = "describe('platform stats', () => {});\n",
  } = {}
) {
  writeFile(path.join(repoRoot, "tests", "trading.ts"), trading);
  writeFile(path.join(repoRoot, "tests", "integration_trading.ts"), integration);
  writeFile(path.join(repoRoot, "tests", "security_regression_static.ts"), security);
  writeFile(path.join(repoRoot, "tests", "platform_stats_service.ts"), platformStats);
}

test("checkIdlSync skips strict comparison when --if-present mode lacks anchor artifact", () => {
  withTempDir((repoRoot) => {
    const messages = [];
    const result = checkIdlSync({
      repoRoot,
      ifPresent: true,
      log: (message) => messages.push(message),
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "missing-canonical-idl");
    assert.match(messages.join(" "), /anchor build/i);
  });
});

test("checkIdlSync fails in strict mode when anchor artifact is missing", () => {
  withTempDir((repoRoot) => {
    assert.throws(
      () =>
        checkIdlSync({
          repoRoot,
          ifPresent: false,
          log: () => {},
        }),
      /anchor build/i
    );
  });
});

test("checkIdlSync passes when canonical and SDK IDLs match", () => {
  withTempDir((repoRoot) => {
    writeFile(
      path.join(repoRoot, "target", "idl", "stendar.json"),
      '{\n  "version": "0.1.0"\n}\n'
    );
    writeFile(
      path.join(repoRoot, "sdk", "src", "idl", "stendar.json"),
      '{\r\n  "version": "0.1.0"\r\n}\r\n'
    );

    const result = checkIdlSync({
      repoRoot,
      ifPresent: false,
      log: () => {},
    });
    assert.equal(result.status, "matched");
  });
});

test("checkIdlSync fails when canonical and SDK IDLs drift", () => {
  withTempDir((repoRoot) => {
    writeFile(
      path.join(repoRoot, "target", "idl", "stendar.json"),
      '{\n  "version": "0.1.0"\n}\n'
    );
    writeFile(
      path.join(repoRoot, "sdk", "src", "idl", "stendar.json"),
      '{\n  "version": "0.2.0"\n}\n'
    );

    assert.throws(
      () =>
        checkIdlSync({
          repoRoot,
          ifPresent: false,
          log: () => {},
        }),
      /IDL drift detected/i
    );
  });
});

test("checkIdlSync fails when SDK IDL is missing but canonical artifact exists", () => {
  withTempDir((repoRoot) => {
    writeFile(
      path.join(repoRoot, "target", "idl", "stendar.json"),
      '{\n  "version": "0.1.0"\n}\n'
    );

    assert.throws(
      () =>
        checkIdlSync({
          repoRoot,
          ifPresent: false,
          log: () => {},
        }),
      /sdk.*src.*idl.*stendar\.json/i
    );
  });
});

test("scanDeterministicPendingTests reports pending markers in deterministic suites", () => {
  withTempDir((repoRoot) => {
    writeDeterministicRegressionFiles(repoRoot, {
      trading: "describe('trading', function () {\n  this.skip();\n});\n",
    });

    const result = scanDeterministicPendingTests({ repoRoot });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].filePath, "tests/trading.ts");
    assert.equal(result.violations[0].markers[0].line, 2);
  });
});

test("scanDeterministicPendingTests reports exclusive markers in deterministic suites", () => {
  withTempDir((repoRoot) => {
    writeDeterministicRegressionFiles(repoRoot, {
      trading: "describe.only('trading', function () {});\n",
    });

    const result = scanDeterministicPendingTests({ repoRoot });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].markers[0].marker, "describe.only(");
  });
});

test("scanDeterministicPendingTests reports legacy exclusive test markers", () => {
  withTempDir((repoRoot) => {
    writeDeterministicRegressionFiles(repoRoot, {
      trading: "xdescribe('trading', function () {});\nxit('skips', function () {});\n",
    });

    const result = scanDeterministicPendingTests({ repoRoot });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].markers.length, 2);
  });
});

test("scanDeterministicPendingTests reports Mocha alias pending markers", () => {
  withTempDir((repoRoot) => {
    writeDeterministicRegressionFiles(repoRoot, {
      trading: [
        "context.skip('context alias', function () {});",
        "suite.only('suite alias', function () {});",
        "specify.skip('specify alias', function () {});",
        "",
      ].join("\n"),
    });

    const result = scanDeterministicPendingTests({ repoRoot });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].markers.length, 3);
  });
});

test("scanDeterministicPendingTests reports legacy Mocha alias pending markers", () => {
  withTempDir((repoRoot) => {
    writeDeterministicRegressionFiles(repoRoot, {
      trading: [
        "xcontext('context alias', function () {});",
        "xsuite('suite alias', function () {});",
        "xspecify('specify alias', function () {});",
        "",
      ].join("\n"),
    });

    const result = scanDeterministicPendingTests({ repoRoot });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].markers.length, 3);
  });
});

test("scanDeterministicPendingTests ignores comment-only pending marker examples", () => {
  withTempDir((repoRoot) => {
    writeDeterministicRegressionFiles(repoRoot, {
      trading: [
        "// Do not use this.skip() in deterministic tests.",
        "/* Do not use describe.only() either. */",
        "/*",
        " * Avoid it.skip() in deterministic tests.",
        " */",
        "describe('trading', () => {});",
        "",
      ].join("\n"),
    });

    const result = scanDeterministicPendingTests({ repoRoot });
    assert.equal(result.violations.length, 0);
  });
});

test("scanDeterministicPendingTests still detects markers after comments close", () => {
  withTempDir((repoRoot) => {
    writeDeterministicRegressionFiles(repoRoot, {
      trading: "/* commented this.skip() */ describe.only('trading', () => {});\n",
    });

    const result = scanDeterministicPendingTests({ repoRoot });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].markers[0].marker, "describe.only(");
  });
});

test("scanDeterministicPendingTests does not treat comment delimiters inside strings as comments", () => {
  withTempDir((repoRoot) => {
    writeDeterministicRegressionFiles(repoRoot, {
      trading: [
        "const opening = '/*'; this.skip();",
        "const closing = \"*/\"; describe.only('trading', () => {});",
        "",
      ].join("\n"),
    });

    const result = scanDeterministicPendingTests({ repoRoot });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].markers.length, 2);
  });
});

test("scanDeterministicPendingTests ignores marker text inside string literals", () => {
  withTempDir((repoRoot) => {
    writeDeterministicRegressionFiles(repoRoot, {
      trading: [
        "const message = \"this.skip() and describe.only() are text only\";",
        "const template = `",
        "  it.skip() inside a multiline template is still text",
        "`;",
        "describe('trading', () => {});",
        "",
      ].join("\n"),
    });

    const result = scanDeterministicPendingTests({ repoRoot });
    assert.equal(result.violations.length, 0);
  });
});

test("scanDeterministicPendingTests detects markers after multiline templates close", () => {
  withTempDir((repoRoot) => {
    writeDeterministicRegressionFiles(repoRoot, {
      trading: [
        "const template = `",
        "  this.skip() text only",
        "`; it.only('real exclusive test', () => {});",
        "",
      ].join("\n"),
    });

    const result = scanDeterministicPendingTests({ repoRoot });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].markers[0].marker, "it.only(");
  });
});

test("scanDeterministicPendingTests fails closed when deterministic files are missing", () => {
  withTempDir((repoRoot) => {
    writeFile(
      path.join(repoRoot, "tests", "trading.ts"),
      "describe('trading', () => {});\n"
    );

    assert.throws(
      () => scanDeterministicPendingTests({ repoRoot }),
      /Deterministic regression file is missing/i
    );
  });
});

test("runDeterministicPendingScan allows documented environment-gated skips", () => {
  withTempDir((repoRoot) => {
    writeDeterministicRegressionFiles(repoRoot);
    writeFile(
      path.join(repoRoot, "tests", "pool_lifecycle.ts"),
      "describe('pool lifecycle', function () {\n  this.skip();\n});\n"
    );
    writeFile(
      path.join(repoRoot, "tests", "revolving_lifecycle.ts"),
      "describe('revolving lifecycle', function () {\n  this.skip();\n});\n"
    );

    const messages = [];
    const result = runDeterministicPendingScan({
      repoRoot,
      log: (message) => messages.push(message),
    });

    assert.equal(result.violations.length, 0);
    assert.ok(
      DOCUMENTED_ENV_GATED_SUITES.every((suitePath) =>
        messages.join(" ").includes(suitePath)
      )
    );
  });
});

test("documented environment-gated suite list covers all checked-in this.skip() suites", () => {
  const scanDirectories = ["tests", path.join("programs", "stendar", "tests")];
  const filesWithRuntimeSkips = scanDirectories
    .flatMap((relativeDirectory) =>
      fs
        .readdirSync(path.join(REPO_ROOT, relativeDirectory))
        .filter((fileName) => fileName.endsWith(".ts"))
        .map((fileName) => path.join(relativeDirectory, fileName))
    )
    .filter((relativePath) => {
      const content = fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
      return findPendingMarkers(content).length > 0;
    })
    .sort();

  assert.deepEqual([...DOCUMENTED_ENV_GATED_SUITES].sort(), filesWithRuntimeSkips);
});

test("deterministic pending scan file list stays in sync with test:regression script", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const regressionScript = packageJson.scripts["test:regression"];
  const regressionFiles = regressionScript
    .split(/\s+/)
    .filter((token) => token.startsWith("tests/") && token.endsWith(".ts"))
    .sort();

  assert.deepEqual([...DEFAULT_DETERMINISTIC_TEST_FILES].sort(), regressionFiles);
  assert.match(regressionScript, /--forbid-pending/);
  assert.match(regressionScript, /--forbid-only/);
});

test("local test:ci script includes the root CI gate commands", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const ciScript = packageJson.scripts["test:ci"];

  for (const command of [
    "npm run test:security-scripts",
    "npm run test:pending:deterministic",
    "npm run test:regression",
    "npm run idl:check:if-present",
    "npm run audit:gate",
  ]) {
    assert.match(ciScript, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
