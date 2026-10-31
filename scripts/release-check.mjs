import fs from "node:fs";
import { validateReleaseManifest } from "../lib/release.js";

const root = new URL("..", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("release.json", root), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8"));
const result = validateReleaseManifest({
  manifest,
  packageJsonVersion: packageJson.version,
  lockfilePackageManager: packageJson.packageManager,
  config: process.env,
});
console.log(`release manifest verified: ${result.packageVersion} (${result.enabledFlags.length} flags, ${result.migrationIds.length} migrations)`);
