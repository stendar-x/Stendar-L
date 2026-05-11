#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");

function readJson(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`[security] unable to read ${path.relative(process.cwd(), filePath)}: ${String(error)}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`[security] invalid JSON in ${path.relative(process.cwd(), filePath)}: ${String(error)}`);
  }
}

function listJsonFiles(directoryPath) {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function formatValidationErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return "unknown schema validation error";
  }

  return errors
    .map((error) => {
      const location = typeof error.instancePath === "string" && error.instancePath.length > 0
        ? error.instancePath
        : "/";
      return `${location}: ${error.message}`;
    })
    .join("; ");
}

function createSchemaValidator() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    strictRequired: false,
  });
  addFormats(ajv);

  const validatorCache = new Map();

  function getValidator(manifestPath, schemaReference) {
    const label = path.relative(process.cwd(), manifestPath);
    if (typeof schemaReference !== "string" || schemaReference.trim().length === 0) {
      throw new Error(`[security] ${label}: missing required "$schema" declaration`);
    }

    const normalizedReference = schemaReference.trim();

    if (normalizedReference.startsWith(".") || path.isAbsolute(normalizedReference)) {
      const resolvedSchemaPath = path.resolve(path.dirname(manifestPath), normalizedReference);
      if (!validatorCache.has(resolvedSchemaPath)) {
        const schemaJson = readJson(resolvedSchemaPath);
        validatorCache.set(resolvedSchemaPath, ajv.compile(schemaJson));
      }

      return {
        validate: validatorCache.get(resolvedSchemaPath),
        schemaLabel: path.relative(process.cwd(), resolvedSchemaPath),
      };
    }

    const builtInValidator = ajv.getSchema(normalizedReference);
    if (builtInValidator) {
      return {
        validate: builtInValidator,
        schemaLabel: normalizedReference,
      };
    }

    throw new Error(
      `[security] ${label}: unable to resolve declared schema "${normalizedReference}"`,
    );
  }

  function validateFile(filePath, manifest) {
    const { validate, schemaLabel } = getValidator(
      filePath,
      manifest && typeof manifest === "object" ? manifest.$schema : undefined,
    );

    const isValid = validate(manifest);
    if (!isValid) {
      const label = path.relative(process.cwd(), filePath);
      throw new Error(
        `[security] ${label}: schema validation failed against "${schemaLabel}": ${formatValidationErrors(validate.errors)}`,
      );
    }
  }

  return {
    validateFile,
  };
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

function validateCollateralManifestRules(filePath, manifest) {
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

function validateManifestSchema(filePath, schemaValidator = createSchemaValidator()) {
  const manifest = readJson(filePath);
  schemaValidator.validateFile(filePath, manifest);
  return manifest;
}

function validateManifestFile(filePath, schemaValidator = createSchemaValidator()) {
  const manifest = validateManifestSchema(filePath, schemaValidator);
  validateCollateralManifestRules(filePath, manifest);
  return manifest;
}

function validateSecurityDirectory(securityDirectoryPath) {
  const schemaValidator = createSchemaValidator();
  const securityJsonFiles = listJsonFiles(securityDirectoryPath);
  const validatedFiles = [];

  for (const filePath of securityJsonFiles) {
    const manifest = validateManifestSchema(filePath, schemaValidator);
    validatedFiles.push(filePath);

    if (
      path.basename(path.dirname(filePath)) === "collateral-listings" &&
      path.basename(filePath) !== "schema.json"
    ) {
      validateCollateralManifestRules(filePath, manifest);
    }
  }

  return validatedFiles;
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const securityDirectoryPath = path.join(repoRoot, "security");
  const validatedFiles = validateSecurityDirectory(securityDirectoryPath);
  console.log(`[security] validated ${validatedFiles.length} security JSON file(s) against declared schema.`);
  console.log("[security] collateral listing environment + mint uniqueness checks passed.");
}

if (require.main === module) {
  main();
}

module.exports = {
  createSchemaValidator,
  formatValidationErrors,
  listJsonFiles,
  readJson,
  validateCollateralManifestRules,
  validateCollateralListingsUniqueness,
  validateManifestSchema,
  validateManifestFile,
  validateSecurityDirectory,
};
