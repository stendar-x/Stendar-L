#!/usr/bin/env node

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

const WORKSPACES = [
  { name: 'root', cwd: REPO_ROOT },
  { name: 'sdk', cwd: path.join(REPO_ROOT, 'sdk') },
];

const ALLOWLIST_PATH = path.join(REPO_ROOT, 'security', 'npm-audit-allowlist.json');
const SUPPORTED_SEVERITIES = new Set(['low', 'moderate', 'high', 'critical']);
const CRITICAL_SEVERITY = 'critical';
const SEVERITY_RANK = {
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeSeverity(value) {
  if (!isNonEmptyString(value)) {
    return 'unknown';
  }
  return value.trim().toLowerCase();
}

function normalizeAdvisoryId(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }
  const ghsaMatch = value.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
  return ghsaMatch ? ghsaMatch[0].toUpperCase() : null;
}

function parseIsoDate(value, fieldName, label, options = {}) {
  if (!isNonEmptyString(value)) {
    throw new Error(`[security] ${label}: "${fieldName}" must be a non-empty ISO date string.`);
  }

  const trimmed = value.trim();
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const normalized = isDateOnly
    ? `${trimmed}${options.dateOnlyEndOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}`
    : trimmed;
  const timestamp = Date.parse(normalized);

  if (Number.isNaN(timestamp)) {
    throw new Error(`[security] ${label}: "${fieldName}" must be an ISO date or date-time.`);
  }

  return {
    raw: trimmed,
    timestamp,
  };
}

function normalizeAllowlistAdvisories(entry, label) {
  const advisoryValues = [];
  if (isNonEmptyString(entry.advisory)) {
    advisoryValues.push(entry.advisory);
  }
  if (isNonEmptyString(entry.source)) {
    advisoryValues.push(entry.source);
  }
  if (Array.isArray(entry.advisories)) {
    advisoryValues.push(...entry.advisories);
  }

  const advisories = Array.from(
    new Set(advisoryValues.map(normalizeAdvisoryId).filter(Boolean)),
  );

  if (advisories.length === 0) {
    throw new Error(`[security] ${label}: "advisory", "source", or "advisories" is required.`);
  }

  return advisories;
}

function normalizeAllowlistEntry(workspaceName, entry, index, now = new Date()) {
  const label = `allowlist projects.${workspaceName}[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`[security] ${label}: entry must be an object with metadata.`);
  }

  const packageName = isNonEmptyString(entry.package) ? entry.package.trim() : '';
  if (!packageName) {
    throw new Error(`[security] ${label}: "package" is required.`);
  }

  const advisories = normalizeAllowlistAdvisories(entry, label);

  const reason = isNonEmptyString(entry.reason) ? entry.reason.trim() : '';
  if (!reason) {
    throw new Error(`[security] ${label}: "reason" is required.`);
  }

  const owner = isNonEmptyString(entry.owner) ? entry.owner.trim() : '';
  if (!owner) {
    throw new Error(`[security] ${label}: "owner" is required.`);
  }

  const severity = normalizeSeverity(entry.severity);
  if (!SUPPORTED_SEVERITIES.has(severity)) {
    throw new Error(`[security] ${label}: unsupported severity "${entry.severity}".`);
  }
  if (severity === CRITICAL_SEVERITY) {
    throw new Error(`[security] ${label}: critical findings cannot be allowlisted.`);
  }

  const introducedAt = isNonEmptyString(entry.introducedAt)
    ? parseIsoDate(entry.introducedAt, 'introducedAt', label).raw
    : null;
  const updatedAt = isNonEmptyString(entry.updatedAt)
    ? parseIsoDate(entry.updatedAt, 'updatedAt', label).raw
    : null;

  if (!introducedAt && !updatedAt) {
    throw new Error(`[security] ${label}: either "introducedAt" or "updatedAt" is required.`);
  }

  const expiresAt = parseIsoDate(entry.expiresAt, 'expiresAt', label, { dateOnlyEndOfDay: true });
  if (expiresAt.timestamp <= now.getTime()) {
    throw new Error(`[security] ${label}: allowlist entry expired on ${expiresAt.raw}.`);
  }

  return {
    workspace: workspaceName,
    packageName,
    advisory: advisories[0],
    advisories,
    severity,
    reason,
    owner,
    introducedAt,
    updatedAt,
    expiresAt: expiresAt.raw,
  };
}

function loadAllowlistByWorkspace(allowlistPath = ALLOWLIST_PATH, now = new Date()) {
  let allowlistJson;
  try {
    allowlistJson = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to load audit allowlist from ${allowlistPath}: ${String(error)}`);
  }

  const projects = allowlistJson && typeof allowlistJson === 'object' ? allowlistJson.projects : null;
  if (!projects || typeof projects !== 'object') {
    throw new Error('[security] allowlist file must contain a top-level "projects" object.');
  }

  const allowlistByWorkspace = {};

  for (const workspace of WORKSPACES) {
    const workspaceEntries = projects[workspace.name];
    if (!Array.isArray(workspaceEntries)) {
      throw new Error(`[security] allowlist projects.${workspace.name} must be an array.`);
    }

    const byPackage = new Map();
    workspaceEntries.forEach((entry, index) => {
      const normalized = normalizeAllowlistEntry(workspace.name, entry, index, now);
      if (byPackage.has(normalized.packageName)) {
        throw new Error(
          `[security] allowlist projects.${workspace.name}: duplicate package entry "${normalized.packageName}".`,
        );
      }
      byPackage.set(normalized.packageName, normalized);
    });

    allowlistByWorkspace[workspace.name] = byPackage;
  }

  return allowlistByWorkspace;
}

function parseAuditJson(workspaceName, cwd, execFileSyncFn = execFileSync) {
  let stdout = '';

  try {
    stdout = execFileSyncFn('npm', ['audit', '--omit=dev', '--json'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // npm audit exits non-zero when vulnerabilities are found.
    if (typeof error.stdout === 'string' && error.stdout.trim().length > 0) {
      stdout = error.stdout;
    } else if (typeof error.stderr === 'string' && error.stderr.trim().startsWith('{')) {
      stdout = error.stderr;
    } else if (typeof error.stderr === 'string' && error.stderr.trim().length > 0) {
      throw new Error(`npm audit failed for ${workspaceName}: ${error.stderr}`);
    } else {
      throw new Error(`npm audit failed for ${workspaceName} with no parsable output.`);
    }
  }

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Unable to parse npm audit JSON for ${workspaceName}: ${String(error)}`);
  }
}

function extractAdvisoryIds(details) {
  const advisoryIds = new Set();
  const via = details && typeof details === 'object' && Array.isArray(details.via) ? details.via : [];

  for (const item of via) {
    if (typeof item === 'string') {
      const ghsaMatch = item.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
      if (ghsaMatch) {
        advisoryIds.add(ghsaMatch[0].toUpperCase());
      }
      continue;
    }

    if (!item || typeof item !== 'object') {
      continue;
    }

    for (const fieldName of ['source', 'url', 'title']) {
      const fieldValue = item[fieldName];
      if (typeof fieldValue !== 'string') {
        continue;
      }
      const ghsaMatch = fieldValue.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
      if (ghsaMatch) {
        advisoryIds.add(ghsaMatch[0].toUpperCase());
      }
    }
  }

  return advisoryIds;
}

function extractFindings(workspaceName, auditJson) {
  const vulnerabilities = auditJson && typeof auditJson === 'object' ? auditJson.vulnerabilities || {} : {};
  const findings = [];

  for (const [packageName, details] of Object.entries(vulnerabilities)) {
    findings.push({
      workspace: workspaceName,
      packageName,
      severity: normalizeSeverity(
        typeof details === 'object' && details && 'severity' in details ? details.severity : 'unknown',
      ),
      advisoryIds: extractAdvisoryIds(details),
    });
  }

  return findings;
}

function evaluateFindings(findings, allowlistByWorkspace) {
  const allowedFindings = [];
  const disallowedFindings = [];

  for (const finding of findings) {
    if (!SUPPORTED_SEVERITIES.has(finding.severity)) {
      disallowedFindings.push({
        ...finding,
        reason: `Unrecognized finding severity "${finding.severity}".`,
      });
      continue;
    }

    if (finding.severity === CRITICAL_SEVERITY) {
      disallowedFindings.push({
        ...finding,
        reason: 'Critical vulnerabilities are never allowlisted.',
      });
      continue;
    }

    const workspaceAllowlist = allowlistByWorkspace[finding.workspace];
    const allowlistEntry = workspaceAllowlist instanceof Map
      ? workspaceAllowlist.get(finding.packageName)
      : undefined;

    if (allowlistEntry) {
      if (allowlistEntry.severity === CRITICAL_SEVERITY) {
        disallowedFindings.push({
          ...finding,
          reason: 'Allowlist entry has critical severity, which is not permitted.',
        });
        continue;
      }

      if ((SEVERITY_RANK[finding.severity] || 0) > (SEVERITY_RANK[allowlistEntry.severity] || 0)) {
        disallowedFindings.push({
          ...finding,
          reason: `Finding severity "${finding.severity}" exceeds allowlisted severity "${allowlistEntry.severity}".`,
        });
        continue;
      }

      if (!(finding.advisoryIds instanceof Set) || finding.advisoryIds.size === 0) {
        disallowedFindings.push({
          ...finding,
          reason: 'Audit finding does not include advisory metadata for allowlist verification.',
        });
        continue;
      }

      const allowlistedAdvisories = new Set(allowlistEntry.advisories);
      const uncoveredAdvisories = Array.from(finding.advisoryIds).filter(
        (advisoryId) => !allowlistedAdvisories.has(advisoryId),
      );

      if (uncoveredAdvisories.length > 0) {
        disallowedFindings.push({
          ...finding,
          reason: `Audit finding has uncovered advisories: ${uncoveredAdvisories.join(', ')}.`,
        });
        continue;
      }

      allowedFindings.push({
        ...finding,
        allowlist: allowlistEntry,
        reason: 'Matched allowlist metadata entry.',
      });
      continue;
    }

    disallowedFindings.push({
      ...finding,
      reason: 'Not present in workspace allowlist.',
    });
  }

  return {
    allowedFindings,
    disallowedFindings,
  };
}

function runAuditGate(options = {}) {
  const workspaces = Array.isArray(options.workspaces) ? options.workspaces : WORKSPACES;
  const parseAuditJsonFn = typeof options.parseAuditJson === 'function' ? options.parseAuditJson : parseAuditJson;
  const now = options.now instanceof Date ? options.now : new Date();
  const allowlistByWorkspace = options.allowlistByWorkspace || loadAllowlistByWorkspace(
    options.allowlistPath || ALLOWLIST_PATH,
    now,
  );

  const findings = [];
  for (const workspace of workspaces) {
    const auditJson = parseAuditJsonFn(workspace.name, workspace.cwd);
    findings.push(...extractFindings(workspace.name, auditJson));
  }

  const { allowedFindings, disallowedFindings } = evaluateFindings(findings, allowlistByWorkspace);
  return {
    allowedFindings,
    disallowedFindings,
  };
}

function main() {
  let gateResult;
  try {
    gateResult = runAuditGate();
  } catch (error) {
    console.error(`\n[security] audit gate failed: ${error.message}`);
    process.exit(1);
  }

  const { allowedFindings, disallowedFindings } = gateResult;

  if (disallowedFindings.length > 0) {
    console.error('\n[security] audit gate failed: unallowlisted production vulnerabilities detected.');
    for (const finding of disallowedFindings) {
      console.error(
        `- ${finding.workspace}:${finding.packageName} (${finding.severity}) -> ${finding.reason}`
      );
    }
    process.exit(1);
  }

  console.log('\n[security] audit gate passed.');
  if (allowedFindings.length > 0) {
    console.log(
      `[security] allowlisted findings (${allowedFindings.length}) remain tracked until upstream fixes land:`,
    );
    for (const finding of allowedFindings) {
      const metadata = finding.allowlist;
      console.log(
        `- ${finding.workspace}:${finding.packageName} (${finding.severity}) advisories=${metadata.advisories.join(',')} owner=${metadata.owner} expiresAt=${metadata.expiresAt}`,
      );
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ALLOWLIST_PATH,
  CRITICAL_SEVERITY,
  SEVERITY_RANK,
  SUPPORTED_SEVERITIES,
  WORKSPACES,
  evaluateFindings,
  extractAdvisoryIds,
  extractFindings,
  isNonEmptyString,
  loadAllowlistByWorkspace,
  normalizeAdvisoryId,
  normalizeAllowlistAdvisories,
  normalizeAllowlistEntry,
  normalizeSeverity,
  parseAuditJson,
  parseIsoDate,
  runAuditGate,
};
