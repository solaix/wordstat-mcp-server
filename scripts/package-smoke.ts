import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  Client,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const PACKAGE_NAME = "wordstat-mcp-server";
const EXPECTED_TOOLS = [
  "wordstat_dynamics",
  "wordstat_find_regions",
  "wordstat_regions",
  "wordstat_regions_tree",
  "wordstat_top_requests",
];
const PROCESS_TIMEOUT_MS = 120_000;
const MCP_TIMEOUT_MS = 15_000;

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface PackResult {
  filename: string;
}

function sanitizedEnvironment(npmCacheDirectory?: string): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !entry[0].startsWith("YANDEX_WORDSTAT_"),
      ),
    ),
    ...(npmCacheDirectory ? { npm_config_cache: npmCacheDirectory } : {}),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${operation} timed out`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(`${operation} failed`));
      },
    );
  });
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  npmCacheDirectory: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: sanitizedEnvironment(npmCacheDirectory),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} ${args[0] ?? ""} timed out`));
    }, PROCESS_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} exited with ${code ?? `signal ${signal ?? "unknown"}`}: ${stderr.slice(0, 2_000)}`,
        ),
      );
    });
  });
}

function runNpm(args: string[], cwd: string, npmCacheDirectory: string): Promise<CommandResult> {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    throw new Error("npm_execpath is unavailable; run this smoke through npm run smoke:package");
  }
  return runCommand(process.execPath, [npmExecPath, ...args], cwd, npmCacheDirectory);
}

function parsePackResult(stdout: string): PackResult {
  if (!stdout.trim()) {
    throw new Error(
      "npm pack produced no stdout; run the package smoke on a host that supports nested child-process stdio",
    );
  }
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack did not return exactly one package");
  }
  const item: unknown = parsed[0];
  if (item === null || typeof item !== "object" || !("filename" in item)) {
    throw new Error("npm pack result does not contain a filename");
  }
  const filename = item.filename;
  if (typeof filename !== "string" || path.basename(filename) !== filename) {
    throw new Error("npm pack returned an unsafe filename");
  }
  return { filename };
}

function assertConfigurationError(result: CallToolResult): void {
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: "CONFIGURATION_ERROR",
      message: "Set exactly one of YANDEX_WORDSTAT_API_KEY or YANDEX_WORDSTAT_IAM_TOKEN",
      retryable: false,
    },
  });
}

async function smokeProtocol(
  cliPath: string,
  installDirectory: string,
  protocolVersion: string,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
    cwd: installDirectory,
    env: sanitizedEnvironment(),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: unknown) => {
    if (typeof chunk === "string") stderr += chunk;
    else if (Buffer.isBuffer(chunk)) stderr += chunk.toString("utf8");
  });
  const client = new Client(
    { name: "wordstat-package-smoke", version: "1.0.0" },
    { supportedProtocolVersions: [protocolVersion] },
  );

  let failure: Error | undefined;
  try {
    await withTimeout(client.connect(transport), MCP_TIMEOUT_MS, "MCP initialize");

    const tools = await withTimeout(client.listTools(), MCP_TIMEOUT_MS, "tools/list");
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
    const result = await withTimeout(
      client.callTool({
        name: "wordstat_top_requests",
        arguments: { phrase: "package-smoke" },
      }),
      MCP_TIMEOUT_MS,
      "tools/call",
    );
    assertConfigurationError(result);
  } catch (error) {
    failure = error instanceof Error ? error : new Error("Unknown MCP smoke failure");
  }
  try {
    await withTimeout(client.close(), MCP_TIMEOUT_MS, "MCP close");
  } catch (error) {
    const closeError = error instanceof Error ? error : new Error("Unknown MCP close failure");
    failure = failure
      ? new AggregateError([failure, closeError], "MCP operation and close both failed")
      : closeError;
  }
  if (failure) throw failure;

  assert.equal(stderr, "", `Packaged server wrote unexpected stderr: ${stderr.slice(0, 2_000)}`);
}

async function main(): Promise<void> {
  const projectDirectory = process.cwd();
  const sourcePackage = JSON.parse(
    await readFile(path.join(projectDirectory, "package.json"), "utf8"),
  ) as { name?: unknown; version?: unknown };
  assert.equal(sourcePackage.name, PACKAGE_NAME);
  if (typeof sourcePackage.version !== "string") {
    throw new Error("Source package version must be a string");
  }
  const sourceVersion = sourcePackage.version;

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "wordstat-package-smoke-"));
  const packDirectory = path.join(temporaryDirectory, "pack");
  const installDirectory = path.join(temporaryDirectory, "install");
  const npmCacheDirectory = path.join(temporaryDirectory, "npm-cache");

  try {
    await mkdir(packDirectory);
    await mkdir(installDirectory);
    const packed = await runNpm(
      ["pack", "--json", "--pack-destination", packDirectory],
      projectDirectory,
      npmCacheDirectory,
    );
    const { filename } = parsePackResult(packed.stdout);
    const tarballPath = path.join(packDirectory, filename);
    assert.equal((await stat(tarballPath)).isFile(), true);

    await writeFile(
      path.join(installDirectory, "package.json"),
      JSON.stringify({ name: "wordstat-package-smoke", private: true }),
      { encoding: "utf8", mode: 0o600 },
    );
    await runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarballPath,
      ],
      installDirectory,
      npmCacheDirectory,
    );

    const installedPackageDirectory = path.join(installDirectory, "node_modules", PACKAGE_NAME);
    const installedPackage = JSON.parse(
      await readFile(path.join(installedPackageDirectory, "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown; bin?: unknown };
    assert.equal(installedPackage.name, PACKAGE_NAME);
    assert.equal(installedPackage.version, sourceVersion);
    assert.deepEqual(installedPackage.bin, { [PACKAGE_NAME]: "dist/cli.js" });

    const cliPath = path.join(installedPackageDirectory, "dist", "cli.js");
    assert.equal((await stat(cliPath)).isFile(), true);
    const protocolVersions = SUPPORTED_PROTOCOL_VERSIONS.slice(0, 2);
    assert.equal(protocolVersions.length, 2);
    for (const protocolVersion of protocolVersions) {
      await smokeProtocol(cliPath, installDirectory, protocolVersion);
    }

    console.log(
      JSON.stringify({
        ok: true,
        package: `${PACKAGE_NAME}@${sourceVersion}`,
        protocolVersions,
        tools: EXPECTED_TOOLS.length,
      }),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown package smoke failure";
  console.error(message);
  process.exitCode = 1;
});
