import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface PackageJson {
  name: string;
  version: string;
  mcpName: string;
  repository: { url: string };
}

interface ServerJson {
  $schema: string;
  name: string;
  version: string;
  repository: { url: string; source: string };
  packages: Array<{ registryType: string; identifier: string; version: string }>;
}

const EXPECTED_REPOSITORY = "https://github.com/solaix/wordstat-mcp-server";

function normalizeRepositoryUrl(url: string): string {
  return url
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

test("package and MCP Registry metadata stay aligned", async () => {
  const [packageContents, serverContents] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("server.json", "utf8"),
  ]);
  const packageJson = JSON.parse(packageContents) as PackageJson;
  const serverJson = JSON.parse(serverContents) as ServerJson;

  assert.equal(packageJson.mcpName, serverJson.name);
  assert.equal(serverJson.version, packageJson.version);
  assert.equal(serverJson.repository.source, "github");
  assert.equal(normalizeRepositoryUrl(packageJson.repository.url), EXPECTED_REPOSITORY);
  assert.equal(normalizeRepositoryUrl(serverJson.repository.url), EXPECTED_REPOSITORY);
  assert.match(serverJson.$schema, /^https:\/\/static\.modelcontextprotocol\.io\/schemas\//);

  assert.equal(serverJson.packages.length, 1);
  const registryPackage = serverJson.packages[0];
  assert.ok(registryPackage);
  assert.equal(registryPackage.registryType, "npm");
  assert.equal(registryPackage.identifier, packageJson.name);
  assert.equal(registryPackage.version, packageJson.version);
});
