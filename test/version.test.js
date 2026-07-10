import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ADAPTER_VERSION } from "../dist/version.js";

test("adapter version comes from package.json", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(ADAPTER_VERSION, pkg.version);
});
