import { describe, expect, it } from "vitest";
import { validateReleaseManifest } from "../../src/release.js";

const valid = {
  packageVersion: "0.1.0",
  packageManager: "pnpm@11.19.0",
  requiredConfig: ["COLLAB_AUTH_SERVICE"],
  featureFlags: { collab: true, approvals: false },
  migrations: [{ id: "runtime-v1", rollback: "Restore previous runtime snapshot format" }],
  rollback: { owner: "host-team", steps: ["Disable collab", "Restore previous plugin"] },
};

describe("release manifest validation", () => {
  it("accepts a complete manifest and returns a rollback plan", () => {
    expect(validateReleaseManifest({ manifest: valid, packageJsonVersion: "0.1.0", lockfilePackageManager: "pnpm@11.19.0", config: { COLLAB_AUTH_SERVICE: "dsh-auth" } })).toEqual({
      packageVersion: "0.1.0",
      packageManager: "pnpm@11.19.0",
      enabledFlags: ["collab"],
      migrationIds: ["runtime-v1"],
      rollbackOwner: "host-team",
      rollbackSteps: ["Disable collab", "Restore previous plugin"],
    });
  });

  it("rejects version drift, missing config, ambiguous flags, and incomplete rollback", () => {
    expect(() => validateReleaseManifest({ manifest: valid, packageJsonVersion: "0.2.0", lockfilePackageManager: "pnpm@11.19.0", config: { COLLAB_AUTH_SERVICE: "dsh-auth" } })).toThrow("package version");
    expect(() => validateReleaseManifest({ manifest: valid, packageJsonVersion: "0.1.0", lockfilePackageManager: "pnpm@11.19.0", config: {} })).toThrow("required config");
    expect(() => validateReleaseManifest({ manifest: { ...valid, featureFlags: { collab: undefined as never } }, packageJsonVersion: "0.1.0", lockfilePackageManager: "pnpm@11.19.0", config: { COLLAB_AUTH_SERVICE: "dsh-auth" } })).toThrow("feature flag");
    expect(() => validateReleaseManifest({ manifest: { ...valid, rollback: { owner: "", steps: [] } }, packageJsonVersion: "0.1.0", lockfilePackageManager: "pnpm@11.19.0", config: { COLLAB_AUTH_SERVICE: "dsh-auth" } })).toThrow("rollback");
  });
});
