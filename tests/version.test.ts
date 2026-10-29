import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { VERSION } from "../src/version.js";

test("runtime version matches package.json", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
  assert.equal(VERSION, packageJson.version);
});
