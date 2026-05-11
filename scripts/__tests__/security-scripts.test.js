const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  validateManifestFile,
  validateSecurityDirectory,
} = require('../validate-collateral-listings.js');
const {
  evaluateFindings,
  extractFindings,
  isNonEmptyString,
  loadAllowlistByWorkspace,
  normalizeAdvisoryId,
  normalizeSeverity,
  parseAuditJson,
  parseIsoDate,
  runAuditGate,
} = require('../audit-gate.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COLLATERAL_SCHEMA_PATH = path.join(REPO_ROOT, 'security', 'collateral-listings', 'schema.json');
const DEVNET_MANIFEST_PATH = path.join(REPO_ROOT, 'security', 'collateral-listings', 'devnet.json');

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function withTempDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stendar-security-'));
  try {
    return callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function runCollateralValidation({ fileName = 'devnet.json', mutate } = {}) {
  const manifest = cloneJson(JSON.parse(fs.readFileSync(DEVNET_MANIFEST_PATH, 'utf8')));
  if (typeof mutate === 'function') {
    mutate(manifest);
  }

  return withTempDir((tempDir) => {
    const schemaTargetPath = path.join(tempDir, 'schema.json');
    fs.copyFileSync(COLLATERAL_SCHEMA_PATH, schemaTargetPath);

    const manifestPath = path.join(tempDir, fileName);
    writeJson(manifestPath, manifest);

    return validateManifestFile(manifestPath);
  });
}

function createAllowlistFixture(entryOverrides = {}) {
  return {
    projects: {
      root: [],
      sdk: [
        {
          package: 'uuid',
          advisory: 'GHSA-w5hq-g745-h8pq',
          severity: 'moderate',
          reason: 'Tracked transitive advisory until upstream upgrade path is available.',
          owner: 'Stendar',
          introducedAt: '2026-04-26',
          updatedAt: '2026-05-10',
          expiresAt: '2026-08-10',
          ...entryOverrides,
        },
      ],
    },
  };
}

test('validateSecurityDirectory accepts current checked-in security manifests', () => {
  const validatedFiles = validateSecurityDirectory(path.join(REPO_ROOT, 'security'));
  const relativeFiles = validatedFiles.map((filePath) => path.relative(REPO_ROOT, filePath)).sort();
  assert.deepEqual(relativeFiles, [
    'security/collateral-listings/devnet.json',
    'security/collateral-listings/mainnet.json',
    'security/collateral-listings/schema.json',
    'security/mainnet-build-verification.json',
    'security/mainnet-build-verification.schema.json',
    'security/npm-audit-allowlist.json',
    'security/npm-audit-allowlist.schema.json',
  ]);
});

test('validateManifestFile rejects manifests without $schema', () => {
  assert.throws(
    () => runCollateralValidation({
      mutate: (manifest) => {
        delete manifest.$schema;
      },
    }),
    /missing required "\$schema"/i,
  );
});

test('validateManifestFile rejects environment/filename mismatches', () => {
  assert.throws(
    () => runCollateralValidation({ fileName: 'mainnet.json' }),
    /does not match filename/i,
  );
});

test('validateManifestFile rejects duplicate collateral mint entries', () => {
  assert.throws(
    () => runCollateralValidation({
      mutate: (manifest) => {
        manifest.assets[1].mint = manifest.assets[0].mint;
      },
    }),
    /duplicate collateral mint entries/i,
  );
});

test('validateManifestFile rejects malformed base58-ish fields', () => {
  assert.throws(
    () => runCollateralValidation({
      mutate: (manifest) => {
        manifest.assets[0].mint = 'INVALID0BASE58';
      },
    }),
    /schema validation failed/i,
  );
});

test('validateManifestFile rejects invalid date-time metadata', () => {
  assert.throws(
    () => runCollateralValidation({
      mutate: (manifest) => {
        manifest.updatedAt = 'not-a-date';
      },
    }),
    /schema validation failed/i,
  );
});

test('validateManifestFile rejects additional undeclared properties', () => {
  assert.throws(
    () => runCollateralValidation({
      mutate: (manifest) => {
        manifest.unexpectedProperty = true;
      },
    }),
    /schema validation failed/i,
  );
});

test('loadAllowlistByWorkspace parses metadata-rich entries', () => {
  withTempDir((tempDir) => {
    const allowlistPath = path.join(tempDir, 'allowlist.json');
    writeJson(allowlistPath, createAllowlistFixture());

    const byWorkspace = loadAllowlistByWorkspace(allowlistPath, new Date('2026-05-10T12:00:00Z'));
    assert.ok(byWorkspace.sdk instanceof Map);
    const uuidEntry = byWorkspace.sdk.get('uuid');
    assert.equal(uuidEntry.advisory, 'GHSA-W5HQ-G745-H8PQ');
    assert.deepEqual(uuidEntry.advisories, ['GHSA-W5HQ-G745-H8PQ']);
    assert.equal(uuidEntry.owner, 'Stendar');
    assert.equal(uuidEntry.expiresAt, '2026-08-10');
  });
});

test('loadAllowlistByWorkspace parses multi-advisory entries', () => {
  withTempDir((tempDir) => {
    const allowlistPath = path.join(tempDir, 'allowlist.json');
    writeJson(
      allowlistPath,
      createAllowlistFixture({
        advisory: undefined,
        advisories: [
          'GHSA-w5hq-g745-h8pq',
          'GHSA-aaaa-bbbb-cccc',
        ],
      }),
    );

    const byWorkspace = loadAllowlistByWorkspace(allowlistPath, new Date('2026-05-10T12:00:00Z'));
    assert.deepEqual(byWorkspace.sdk.get('uuid').advisories, [
      'GHSA-W5HQ-G745-H8PQ',
      'GHSA-AAAA-BBBB-CCCC',
    ]);
  });
});

test('loadAllowlistByWorkspace deduplicates GHSA IDs across advisory sources', () => {
  withTempDir((tempDir) => {
    const allowlistPath = path.join(tempDir, 'allowlist.json');
    writeJson(
      allowlistPath,
      createAllowlistFixture({
        source: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq',
        advisories: [
          'ghsa-w5hq-g745-h8pq',
          'GHSA-aaaa-bbbb-cccc',
        ],
      }),
    );

    const byWorkspace = loadAllowlistByWorkspace(allowlistPath, new Date('2026-05-10T12:00:00Z'));
    assert.deepEqual(byWorkspace.sdk.get('uuid').advisories, [
      'GHSA-W5HQ-G745-H8PQ',
      'GHSA-AAAA-BBBB-CCCC',
    ]);
  });
});

test('loadAllowlistByWorkspace rejects non-GHSA advisory identifiers', () => {
  withTempDir((tempDir) => {
    const allowlistPath = path.join(tempDir, 'allowlist.json');
    writeJson(
      allowlistPath,
      createAllowlistFixture({
        advisory: undefined,
        source: '1105092',
      }),
    );

    assert.throws(
      () => loadAllowlistByWorkspace(allowlistPath, new Date('2026-05-10T12:00:00Z')),
      /advisory.*source.*advisories/i,
    );
  });
});

test('loadAllowlistByWorkspace rejects expired entries', () => {
  withTempDir((tempDir) => {
    const allowlistPath = path.join(tempDir, 'allowlist.json');
    writeJson(
      allowlistPath,
      createAllowlistFixture({
        expiresAt: '2026-05-01',
      }),
    );

    assert.throws(
      () => loadAllowlistByWorkspace(allowlistPath, new Date('2026-05-10T12:00:00Z')),
      /expired/i,
    );
  });
});

test('loadAllowlistByWorkspace rejects malformed metadata-free entries', () => {
  withTempDir((tempDir) => {
    const allowlistPath = path.join(tempDir, 'allowlist.json');
    writeJson(allowlistPath, {
      projects: {
        root: [],
        sdk: ['uuid'],
      },
    });

    assert.throws(
      () => loadAllowlistByWorkspace(allowlistPath, new Date('2026-05-10T12:00:00Z')),
      /entry must be an object with metadata/i,
    );
  });
});

test('loadAllowlistByWorkspace rejects critical allowlist severities', () => {
  withTempDir((tempDir) => {
    const allowlistPath = path.join(tempDir, 'allowlist.json');
    writeJson(
      allowlistPath,
      createAllowlistFixture({
        severity: 'critical',
      }),
    );

    assert.throws(
      () => loadAllowlistByWorkspace(allowlistPath, new Date('2026-05-10T12:00:00Z')),
      /cannot be allowlisted/i,
    );
  });
});

test('loadAllowlistByWorkspace rejects duplicate package entries', () => {
  withTempDir((tempDir) => {
    const allowlistPath = path.join(tempDir, 'allowlist.json');
    const fixture = createAllowlistFixture();
    fixture.projects.sdk.push({
      ...fixture.projects.sdk[0],
      advisory: 'GHSA-AAAA-BBBB-CCCC',
    });
    writeJson(allowlistPath, fixture);

    assert.throws(
      () => loadAllowlistByWorkspace(allowlistPath, new Date('2026-05-10T12:00:00Z')),
      /duplicate package entry/i,
    );
  });
});

test('evaluateFindings always rejects critical findings even when package is allowlisted', () => {
  const allowlistByWorkspace = {
    root: new Map(),
    sdk: new Map([
      [
        'uuid',
        {
          packageName: 'uuid',
          advisory: 'GHSA-W5HQ-G745-H8PQ',
          advisories: ['GHSA-W5HQ-G745-H8PQ'],
          severity: 'moderate',
          reason: 'tracked',
          owner: 'Stendar',
          introducedAt: '2026-04-26',
          updatedAt: '2026-05-10',
          expiresAt: '2026-08-10',
        },
      ],
    ]),
  };

  const result = evaluateFindings(
    [
      {
        workspace: 'sdk',
        packageName: 'uuid',
        severity: 'critical',
        advisoryIds: new Set(['GHSA-W5HQ-G745-H8PQ']),
      },
    ],
    allowlistByWorkspace,
  );

  assert.equal(result.allowedFindings.length, 0);
  assert.equal(result.disallowedFindings.length, 1);
  assert.match(result.disallowedFindings[0].reason, /never allowlisted/i);
});

test('evaluateFindings rejects critical-severity allowlist entries defensively', () => {
  const allowlistByWorkspace = {
    root: new Map(),
    sdk: new Map([
      [
        'uuid',
        {
          packageName: 'uuid',
          advisory: 'GHSA-W5HQ-G745-H8PQ',
          advisories: ['GHSA-W5HQ-G745-H8PQ'],
          severity: 'critical',
          reason: 'invalid test entry',
          owner: 'Stendar',
          introducedAt: '2026-04-26',
          updatedAt: '2026-05-10',
          expiresAt: '2026-08-10',
        },
      ],
    ]),
  };

  const result = evaluateFindings(
    [
      {
        workspace: 'sdk',
        packageName: 'uuid',
        severity: 'moderate',
        advisoryIds: new Set(['GHSA-W5HQ-G745-H8PQ']),
      },
    ],
    allowlistByWorkspace,
  );

  assert.equal(result.allowedFindings.length, 0);
  assert.equal(result.disallowedFindings.length, 1);
  assert.match(result.disallowedFindings[0].reason, /critical severity/i);
});


test('evaluateFindings rejects severity escalation beyond allowlisted severity', () => {
  const allowlistByWorkspace = {
    root: new Map(),
    sdk: new Map([
      [
        'uuid',
        {
          packageName: 'uuid',
          advisory: 'GHSA-W5HQ-G745-H8PQ',
          advisories: ['GHSA-W5HQ-G745-H8PQ'],
          severity: 'moderate',
          reason: 'tracked',
          owner: 'Stendar',
          introducedAt: '2026-04-26',
          updatedAt: '2026-05-10',
          expiresAt: '2026-08-10',
        },
      ],
    ]),
  };

  const result = evaluateFindings(
    [
      {
        workspace: 'sdk',
        packageName: 'uuid',
        severity: 'high',
        advisoryIds: new Set(['GHSA-W5HQ-G745-H8PQ']),
      },
    ],
    allowlistByWorkspace,
  );

  assert.equal(result.allowedFindings.length, 0);
  assert.equal(result.disallowedFindings.length, 1);
  assert.match(result.disallowedFindings[0].reason, /exceeds allowlisted severity/i);
});

test('evaluateFindings rejects unrecognized finding severities fail-closed', () => {
  const allowlistByWorkspace = {
    root: new Map(),
    sdk: new Map([
      [
        'uuid',
        {
          packageName: 'uuid',
          advisory: 'GHSA-W5HQ-G745-H8PQ',
          advisories: ['GHSA-W5HQ-G745-H8PQ'],
          severity: 'moderate',
          reason: 'tracked',
          owner: 'Stendar',
          introducedAt: '2026-04-26',
          updatedAt: '2026-05-10',
          expiresAt: '2026-08-10',
        },
      ],
    ]),
  };

  const result = evaluateFindings(
    [
      {
        workspace: 'sdk',
        packageName: 'uuid',
        severity: 'info',
        advisoryIds: new Set(['GHSA-W5HQ-G745-H8PQ']),
      },
    ],
    allowlistByWorkspace,
  );

  assert.equal(result.allowedFindings.length, 0);
  assert.equal(result.disallowedFindings.length, 1);
  assert.match(result.disallowedFindings[0].reason, /unrecognized finding severity/i);
});

test('evaluateFindings rejects unknown finding severities fail-closed', () => {
  const allowlistByWorkspace = {
    root: new Map(),
    sdk: new Map([
      [
        'uuid',
        {
          packageName: 'uuid',
          advisory: 'GHSA-W5HQ-G745-H8PQ',
          advisories: ['GHSA-W5HQ-G745-H8PQ'],
          severity: 'moderate',
          reason: 'tracked',
          owner: 'Stendar',
          introducedAt: '2026-04-26',
          updatedAt: '2026-05-10',
          expiresAt: '2026-08-10',
        },
      ],
    ]),
  };

  const result = evaluateFindings(
    [
      {
        workspace: 'sdk',
        packageName: 'uuid',
        severity: 'unknown',
        advisoryIds: new Set(['GHSA-W5HQ-G745-H8PQ']),
      },
    ],
    allowlistByWorkspace,
  );

  assert.equal(result.allowedFindings.length, 0);
  assert.equal(result.disallowedFindings.length, 1);
  assert.match(result.disallowedFindings[0].reason, /unrecognized finding severity/i);
});

test('evaluateFindings rejects unmatched advisory IDs for allowlisted packages', () => {
  const allowlistByWorkspace = {
    root: new Map(),
    sdk: new Map([
      [
        'uuid',
        {
          packageName: 'uuid',
          advisory: 'GHSA-W5HQ-G745-H8PQ',
          advisories: ['GHSA-W5HQ-G745-H8PQ'],
          severity: 'moderate',
          reason: 'tracked',
          owner: 'Stendar',
          introducedAt: '2026-04-26',
          updatedAt: '2026-05-10',
          expiresAt: '2026-08-10',
        },
      ],
    ]),
  };

  const result = evaluateFindings(
    [
      {
        workspace: 'sdk',
        packageName: 'uuid',
        severity: 'moderate',
        advisoryIds: new Set(['GHSA-AAAA-BBBB-CCCC']),
      },
    ],
    allowlistByWorkspace,
  );

  assert.equal(result.allowedFindings.length, 0);
  assert.equal(result.disallowedFindings.length, 1);
  assert.match(result.disallowedFindings[0].reason, /uncovered advisories/i);
});

test('evaluateFindings rejects allowlisted packages with no advisory metadata', () => {
  const allowlistByWorkspace = {
    root: new Map(),
    sdk: new Map([
      [
        'jayson',
        {
          packageName: 'jayson',
          advisory: 'GHSA-W5HQ-G745-H8PQ',
          advisories: ['GHSA-W5HQ-G745-H8PQ'],
          severity: 'moderate',
          reason: 'tracked',
          owner: 'Stendar',
          introducedAt: '2026-04-26',
          updatedAt: '2026-05-10',
          expiresAt: '2026-08-10',
        },
      ],
    ]),
  };

  const result = evaluateFindings(
    [
      {
        workspace: 'sdk',
        packageName: 'jayson',
        severity: 'moderate',
        advisoryIds: new Set(),
      },
    ],
    allowlistByWorkspace,
  );

  assert.equal(result.allowedFindings.length, 0);
  assert.equal(result.disallowedFindings.length, 1);
  assert.match(result.disallowedFindings[0].reason, /advisory metadata/i);
});

test('evaluateFindings allows matching package severity and advisory metadata', () => {
  const allowlistByWorkspace = {
    root: new Map(),
    sdk: new Map([
      [
        'uuid',
        {
          packageName: 'uuid',
          advisory: 'GHSA-W5HQ-G745-H8PQ',
          advisories: ['GHSA-W5HQ-G745-H8PQ'],
          severity: 'moderate',
          reason: 'tracked',
          owner: 'Stendar',
          introducedAt: '2026-04-26',
          updatedAt: '2026-05-10',
          expiresAt: '2026-08-10',
        },
      ],
    ]),
  };

  const result = evaluateFindings(
    [
      {
        workspace: 'sdk',
        packageName: 'uuid',
        severity: 'moderate',
        advisoryIds: new Set(['GHSA-W5HQ-G745-H8PQ']),
      },
    ],
    allowlistByWorkspace,
  );

  assert.equal(result.allowedFindings.length, 1);
  assert.equal(result.disallowedFindings.length, 0);
});

test('runAuditGate wires workspace audit parsing through allowlist evaluation', () => {
  const allowlistByWorkspace = {
    root: new Map(),
    sdk: new Map([
      [
        'uuid',
        {
          packageName: 'uuid',
          advisory: 'GHSA-W5HQ-G745-H8PQ',
          advisories: ['GHSA-W5HQ-G745-H8PQ'],
          severity: 'moderate',
          reason: 'tracked',
          owner: 'Stendar',
          introducedAt: '2026-04-26',
          updatedAt: '2026-05-10',
          expiresAt: '2026-08-10',
        },
      ],
    ]),
  };

  const result = runAuditGate({
    allowlistByWorkspace,
    workspaces: [
      { name: 'sdk', cwd: '/tmp/sdk' },
    ],
    parseAuditJson: (workspaceName, cwd) => {
      assert.equal(workspaceName, 'sdk');
      assert.equal(cwd, '/tmp/sdk');
      return {
        vulnerabilities: {
          uuid: {
            severity: 'moderate',
            via: [
              {
                url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq',
              },
            ],
          },
        },
      };
    },
  });

  assert.equal(result.allowedFindings.length, 1);
  assert.equal(result.disallowedFindings.length, 0);
});

test('runAuditGate returns disallowed findings from injected audit parser', () => {
  const result = runAuditGate({
    allowlistByWorkspace: {
      root: new Map(),
      sdk: new Map(),
    },
    workspaces: [
      { name: 'sdk', cwd: '/tmp/sdk' },
    ],
    parseAuditJson: () => ({
      vulnerabilities: {
        leftpad: {
          severity: 'high',
          via: [
            {
              url: 'https://github.com/advisories/GHSA-zzzz-yyyy-xxxx',
            },
          ],
        },
      },
    }),
  });

  assert.equal(result.allowedFindings.length, 0);
  assert.equal(result.disallowedFindings.length, 1);
  assert.equal(result.disallowedFindings[0].packageName, 'leftpad');
});

test('evaluateFindings rejects mixed covered and uncovered advisory IDs', () => {
  const allowlistByWorkspace = {
    root: new Map(),
    sdk: new Map([
      [
        'uuid',
        {
          packageName: 'uuid',
          advisory: 'GHSA-W5HQ-G745-H8PQ',
          advisories: ['GHSA-W5HQ-G745-H8PQ'],
          severity: 'moderate',
          reason: 'tracked',
          owner: 'Stendar',
          introducedAt: '2026-04-26',
          updatedAt: '2026-05-10',
          expiresAt: '2026-08-10',
        },
      ],
    ]),
  };

  const result = evaluateFindings(
    [
      {
        workspace: 'sdk',
        packageName: 'uuid',
        severity: 'moderate',
        advisoryIds: new Set(['GHSA-W5HQ-G745-H8PQ', 'GHSA-AAAA-BBBB-CCCC']),
      },
    ],
    allowlistByWorkspace,
  );

  assert.equal(result.allowedFindings.length, 0);
  assert.equal(result.disallowedFindings.length, 1);
  assert.match(result.disallowedFindings[0].reason, /GHSA-AAAA-BBBB-CCCC/);
});

test('extractFindings extracts GHSA IDs from npm audit via metadata', () => {
  const findings = extractFindings('sdk', {
    vulnerabilities: {
      uuid: {
        severity: 'moderate',
        via: [
          {
            source: 1105092,
            url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq',
            title: 'uuid missing bounds checks',
          },
        ],
      },
    },
  });

  assert.equal(findings.length, 1);
  assert.deepEqual(Array.from(findings[0].advisoryIds), ['GHSA-W5HQ-G745-H8PQ']);
});

test('extractFindings returns no advisory IDs for string-only transitive via entries', () => {
  const findings = extractFindings('sdk', {
    vulnerabilities: {
      jayson: {
        severity: 'moderate',
        via: ['uuid'],
      },
    },
  });

  assert.equal(findings.length, 1);
  assert.deepEqual(Array.from(findings[0].advisoryIds), []);
});

test('parseAuditJson parses successful npm audit JSON output', () => {
  const parsed = parseAuditJson('sdk', '/tmp/sdk', () => JSON.stringify({ vulnerabilities: {} }));
  assert.deepEqual(parsed, { vulnerabilities: {} });
});

test('parseAuditJson recovers npm audit JSON from nonzero stdout', () => {
  const error = new Error('npm audit found vulnerabilities');
  error.stdout = JSON.stringify({
    vulnerabilities: {
      uuid: {
        severity: 'moderate',
      },
    },
  });

  const parsed = parseAuditJson('sdk', '/tmp/sdk', () => {
    throw error;
  });

  assert.equal(parsed.vulnerabilities.uuid.severity, 'moderate');
});

test('parseAuditJson recovers npm audit JSON from stderr when stdout is absent', () => {
  const error = new Error('npm audit wrote JSON to stderr');
  error.stderr = JSON.stringify({ vulnerabilities: {} });

  const parsed = parseAuditJson('root', '/tmp/root', () => {
    throw error;
  });

  assert.deepEqual(parsed, { vulnerabilities: {} });
});

test('parseAuditJson fails closed on invalid JSON emitted to stderr', () => {
  const error = new Error('npm audit wrote malformed JSON to stderr');
  error.stderr = '{ not valid json';

  assert.throws(
    () => parseAuditJson('root', '/tmp/root', () => {
      throw error;
    }),
    /unable to parse npm audit json/i,
  );
});

test('parseAuditJson fails closed on non-JSON stderr output', () => {
  const error = new Error('npm audit failed');
  error.stderr = 'registry unavailable';

  assert.throws(
    () => parseAuditJson('root', '/tmp/root', () => {
      throw error;
    }),
    /registry unavailable/i,
  );
});

test('parseAuditJson fails closed when npm audit has no parsable output', () => {
  assert.throws(
    () => parseAuditJson('sdk', '/tmp/sdk', () => {
      throw new Error('network failed');
    }),
    /no parsable output/i,
  );
});

test('parseIsoDate preserves full date-time inputs', () => {
  const parsed = parseIsoDate(
    '2026-08-10T12:34:56.789Z',
    'updatedAt',
    'test allowlist entry',
  );

  assert.equal(parsed.raw, '2026-08-10T12:34:56.789Z');
  assert.equal(parsed.timestamp, Date.parse('2026-08-10T12:34:56.789Z'));
});

test('parseIsoDate treats date-only expiry as valid through end of UTC day', () => {
  const parsed = parseIsoDate(
    '2026-08-10',
    'expiresAt',
    'test allowlist entry',
    { dateOnlyEndOfDay: true },
  );

  assert.equal(parsed.raw, '2026-08-10');
  assert.equal(parsed.timestamp, Date.parse('2026-08-10T23:59:59.999Z'));
});

test('loadAllowlistByWorkspace keeps date-only expiry valid until end of expiry date', () => {
  withTempDir((tempDir) => {
    const allowlistPath = path.join(tempDir, 'allowlist.json');
    writeJson(allowlistPath, createAllowlistFixture({ expiresAt: '2026-08-10' }));

    assert.doesNotThrow(
      () => loadAllowlistByWorkspace(allowlistPath, new Date('2026-08-10T23:59:59.998Z')),
    );
    assert.throws(
      () => loadAllowlistByWorkspace(allowlistPath, new Date('2026-08-10T23:59:59.999Z')),
      /expired/i,
    );
  });
});

test('audit-gate utility functions normalize edge cases consistently', () => {
  assert.equal(normalizeAdvisoryId('https://github.com/advisories/ghsa-w5hq-g745-h8pq'), 'GHSA-W5HQ-G745-H8PQ');
  assert.equal(normalizeAdvisoryId('GHSA-w5hq-g745-h8pq-extra'), 'GHSA-W5HQ-G745-H8PQ');
  assert.equal(normalizeAdvisoryId('1105092'), null);
  assert.equal(normalizeAdvisoryId(''), null);
  assert.equal(normalizeAdvisoryId(null), null);
  assert.equal(normalizeAdvisoryId(undefined), null);
  assert.equal(normalizeSeverity(' HIGH '), 'high');
  assert.equal(normalizeSeverity(123), 'unknown');
  assert.equal(normalizeSeverity(undefined), 'unknown');
  assert.equal(isNonEmptyString(' value '), true);
  assert.equal(isNonEmptyString('   '), false);
  assert.equal(isNonEmptyString(null), false);
});
