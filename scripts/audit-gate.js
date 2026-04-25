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

function loadAllowlistByWorkspace() {
  let allowlistJson;
  try {
    allowlistJson = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to load audit allowlist from ${ALLOWLIST_PATH}: ${String(error)}`);
  }

  const projects = allowlistJson && typeof allowlistJson === 'object' ? allowlistJson.projects : null;
  const rootAllowlist = projects && Array.isArray(projects.root) ? projects.root : [];
  const sdkAllowlist = projects && Array.isArray(projects.sdk) ? projects.sdk : [];

  return {
    root: new Set(rootAllowlist),
    sdk: new Set(sdkAllowlist),
  };
}

const ALLOWLIST_BY_WORKSPACE = loadAllowlistByWorkspace();

function parseAuditJson(workspaceName, cwd) {
  let stdout = '';

  try {
    stdout = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // npm audit exits non-zero when vulnerabilities are found.
    if (typeof error.stdout === 'string' && error.stdout.trim().length > 0) {
      stdout = error.stdout;
    } else if (Buffer.isBuffer(error.stdout) && error.stdout.length > 0) {
      stdout = error.stdout.toString('utf8');
    } else if (typeof error.stderr === 'string' && error.stderr.trim().startsWith('{')) {
      stdout = error.stderr;
    } else if (Buffer.isBuffer(error.stderr) && error.stderr.length > 0) {
      const stderrText = error.stderr.toString('utf8');
      if (stderrText.trim().startsWith('{')) {
        stdout = stderrText;
      } else {
        throw new Error(`npm audit failed for ${workspaceName}: ${stderrText}`);
      }
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

function extractFindings(workspaceName, auditJson) {
  const vulnerabilities = auditJson && typeof auditJson === 'object' ? auditJson.vulnerabilities || {} : {};
  const findings = [];

  for (const [packageName, details] of Object.entries(vulnerabilities)) {
    findings.push({
      workspace: workspaceName,
      packageName,
      severity: typeof details === 'object' && details && 'severity' in details ? details.severity : 'unknown',
    });
  }

  return findings;
}

function main() {
  const allowedFindings = [];
  const disallowedFindings = [];

  for (const workspace of WORKSPACES) {
    const auditJson = parseAuditJson(workspace.name, workspace.cwd);
    const findings = extractFindings(workspace.name, auditJson);
    const workspaceAllowlist = ALLOWLIST_BY_WORKSPACE[workspace.name] || new Set();

    for (const finding of findings) {
      if (finding.severity === 'critical') {
        disallowedFindings.push({
          ...finding,
          reason: 'Critical vulnerabilities are never allowlisted.',
        });
        continue;
      }

      if (workspaceAllowlist.has(finding.packageName)) {
        allowedFindings.push({
          ...finding,
          reason: 'Allowlisted transitive dependency.',
        });
      } else {
        disallowedFindings.push({
          ...finding,
          reason: 'Not present in workspace allowlist.',
        });
      }
    }
  }

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
      `[security] allowlisted findings (${allowedFindings.length}) remain tracked until upstream fixes land:`
    );
    for (const finding of allowedFindings) {
      console.log(`- ${finding.workspace}:${finding.packageName} (${finding.severity})`);
    }
  }
}

main();
