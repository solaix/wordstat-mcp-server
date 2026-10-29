import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function findTestFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findTestFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }

  return files.sort();
}

const testsDirectory = fileURLToPath(new URL("../tests/", import.meta.url));
const testFiles = findTestFiles(testsDirectory);

if (testFiles.length === 0) {
  throw new Error("No test files found");
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status === null) {
  throw new Error(`Test runner terminated by ${result.signal ?? "an unknown signal"}`);
}

process.exitCode = result.status;
