import { readFileSync } from "node:fs";

export const ADAPTER_VERSION = readPackageVersion();

export function readPackageVersion(): string {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: unknown };
    if (typeof packageJson.version === "string" && packageJson.version) {
      return packageJson.version;
    }
  } catch {
    // Fall back for unusual packaged runtimes where package.json is unavailable.
  }
  return "0.0.0-dev";
}
