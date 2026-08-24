import { invalidInput } from "./errors.js";

export interface ReleaseManifest {
  packageVersion: string;
  packageManager: string;
  requiredConfig: string[];
  featureFlags: Record<string, boolean>;
  migrations: Array<{ id: string; rollback: string }>;
  rollback: { owner: string; steps: string[] };
}

export interface ReleaseValidationResult {
  packageVersion: string;
  packageManager: string;
  enabledFlags: string[];
  migrationIds: string[];
  rollbackOwner: string;
  rollbackSteps: string[];
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidInput(field + " must not be blank", { field });
  return value.trim();
}

export function validateReleaseManifest(input: { manifest: ReleaseManifest; packageJsonVersion: string; lockfilePackageManager: string; config: Record<string, string | undefined> }): ReleaseValidationResult {
  const manifest = input.manifest;
  const packageVersion = text(manifest.packageVersion, "package version");
  const packageManager = text(manifest.packageManager, "package manager");
  if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) throw invalidInput("package version must be semver", { packageVersion });
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) throw invalidInput("package manager must pin pnpm version", { packageManager });
  if (packageVersion !== text(input.packageJsonVersion, "package.json version")) throw invalidInput("package version does not match package.json", { packageVersion });
  if (packageManager !== text(input.lockfilePackageManager, "lockfile package manager")) throw invalidInput("package manager does not match lockfile", { packageManager });
  if (!Array.isArray(manifest.requiredConfig)) throw invalidInput("required config must be an array");
  for (const key of manifest.requiredConfig) {
    const name = text(key, "required config key");
    if (typeof input.config[name] !== "string" || input.config[name]!.trim() === "") throw invalidInput("required config is missing", { key: name });
  }
  if (!manifest.featureFlags || typeof manifest.featureFlags !== "object" || Array.isArray(manifest.featureFlags)) throw invalidInput("feature flags must be an object");
  for (const [name, enabled] of Object.entries(manifest.featureFlags)) {
    text(name, "feature flag");
    if (typeof enabled !== "boolean") throw invalidInput("feature flag must be explicit", { name });
  }
  if (!Array.isArray(manifest.migrations)) throw invalidInput("migrations must be an array");
  const migrationIds: string[] = [];
  for (const migration of manifest.migrations) {
    const id = text(migration.id, "migration id");
    if (migrationIds.includes(id)) throw invalidInput("migration id must be unique", { id });
    text(migration.rollback, "migration rollback");
    migrationIds.push(id);
  }
  const rollbackOwner = text(manifest.rollback?.owner, "rollback owner");
  if (!Array.isArray(manifest.rollback?.steps) || manifest.rollback.steps.length === 0) throw invalidInput("rollback must include steps");
  const rollbackSteps = manifest.rollback.steps.map((step) => text(step, "rollback step"));
  return {
    packageVersion,
    packageManager,
    enabledFlags: Object.entries(manifest.featureFlags).filter(([, enabled]) => enabled).map(([name]) => name),
    migrationIds,
    rollbackOwner,
    rollbackSteps,
  };
}
