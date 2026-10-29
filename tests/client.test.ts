import assert from "node:assert/strict";
import test from "node:test";

import { WordstatClient } from "../src/client.js";
import type { WordstatConfig } from "../src/config.js";
import { WordstatError } from "../src/errors.js";

const config: WordstatConfig = {
  authorization: "Api-Key test",
  credentialKind: "api-key",
  folderId: "folder",
  timeoutMs: 1_000,
  maxRetries: 0,
  maxRps: 8,
  maxRph: 100,
  maxConcurrency: 4,
  regionsCacheTtlMs: 86_400_000,
  logLevel: "silent",
};

test("client serializes protobuf int64 input and conditionally includes folderId", async () => {
  let observedBody: unknown;
  const fetchMock: typeof fetch = async (_input, init) => {
    const body = init?.body;
    if (typeof body !== "string") {
      throw new TypeError("Expected a string request body");
    }
    observedBody = JSON.parse(body);
    return Response.json({ totalCount: "1", results: [], associations: [] });
  };
  const client = new WordstatClient(config, fetchMock);
  await client.top({ phrase: "test", numPhrases: 50 }, new AbortController().signal);
  assert.deepEqual(observedBody, { phrase: "test", numPhrases: "50", folderId: "folder" });
});

test("client requests uncompressed upstream responses", async () => {
  let observedAcceptEncoding: string | null | undefined;
  const client = new WordstatClient(config, async (_input, init) => {
    observedAcceptEncoding = new Headers(init?.headers).get("accept-encoding");
    return Response.json({ totalCount: "1", results: [], associations: [] });
  });

  await client.top({ phrase: "test", numPhrases: 1 }, new AbortController().signal);
  assert.equal(observedAcceptEncoding, "identity");
});

test("client reports attempts and preserves decoded numeric precision contract", async () => {
  const fetchMock: typeof fetch = async () =>
    Response.json({
      results: [{ region: "213", count: "9007199254740993", share: 0.5, affinityIndex: "1.25" }],
    });
  const client = new WordstatClient(config, fetchMock);
  const result = await client.regions(
    { phrase: "test", region: "REGION_ALL" },
    new AbortController().signal,
  );
  assert.equal(result.data.results[0]?.count, "9007199254740993");
  assert.equal(result.data.results[0]?.affinityIndex, 1.25);
  assert.equal(result.metadata.httpAttempts, 1);
});

test("diagnostic logging stays on stderr and excludes request data and credentials", async () => {
  const lines: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => lines.push(values.map(String).join(" "));
  try {
    const client = new WordstatClient({ ...config, logLevel: "debug" }, async () =>
      Response.json(
        { totalCount: "1", results: [], associations: [] },
        { headers: { "x-request-id": "safe-request-id" } },
      ),
    );
    await client.top({ phrase: "private phrase", numPhrases: 1 }, new AbortController().signal);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(lines.length, 2);
  assert.match(lines.join("\n"), /http_attempt_started/);
  assert.match(lines.join("\n"), /safe-request-id/);
  assert.doesNotMatch(lines.join("\n"), /private phrase|Api-Key test|folder/);
});

test("client retries retryable 5xx and reports every HTTP attempt", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("temporary", { status: 503 })
      : Response.json({ totalCount: "1", results: [], associations: [] });
  };
  const client = new WordstatClient({ ...config, maxRetries: 2 }, fetchMock, () => 0);
  const result = await client.top({ phrase: "retry", numPhrases: 1 }, new AbortController().signal);
  assert.equal(calls, 2);
  assert.equal(result.metadata.httpAttempts, 2);
  assert.equal(result.metadata.billableCallsEstimate, 2);
});

test("client does not retry permanent authorization errors", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    return new Response("denied", { status: 403 });
  };
  const client = new WordstatClient({ ...config, maxRetries: 2 }, fetchMock, () => 0);
  await assert.rejects(
    client.top({ phrase: "denied", numPhrases: 1 }, new AbortController().signal),
    (error: unknown) =>
      error instanceof WordstatError &&
      error.code === "AUTHORIZATION_ERROR" &&
      error.retryable === false,
  );
  assert.equal(calls, 1);
});

test("client classifies authentication and request validation errors", async () => {
  for (const [status, code] of [
    [400, "VALIDATION_ERROR"],
    [401, "AUTHENTICATION_ERROR"],
  ] as const) {
    const client = new WordstatClient(
      { ...config, maxRetries: 2 },
      async () => new Response("rejected", { status }),
    );
    await assert.rejects(
      client.top({ phrase: "rejected", numPhrases: 1 }, new AbortController().signal),
      (error: unknown) =>
        error instanceof WordstatError &&
        error.code === code &&
        error.status === status &&
        error.httpAttempts === 1,
    );
  }
});

test("Retry-After above 30 seconds is returned without holding the call", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    return new Response("quota", { status: 429, headers: { "retry-after": "31" } });
  };
  const client = new WordstatClient({ ...config, maxRetries: 2 }, fetchMock, () => 0);
  await assert.rejects(
    client.top({ phrase: "quota", numPhrases: 1 }, new AbortController().signal),
    (error: unknown) =>
      error instanceof WordstatError &&
      error.code === "RATE_LIMITED" &&
      error.retryAfterSeconds === 31,
  );
  assert.equal(calls, 1);
});

test("unrepresentable Retry-After values are ignored instead of exposing Infinity", async () => {
  const client = new WordstatClient(
    config,
    async () => new Response("quota", { status: 429, headers: { "retry-after": "9".repeat(400) } }),
  );
  await assert.rejects(
    client.top({ phrase: "quota", numPhrases: 1 }, new AbortController().signal),
    (error: unknown) =>
      error instanceof WordstatError &&
      error.code === "RATE_LIMITED" &&
      error.retryAfterSeconds === undefined,
  );
});

test("timeout covers the active fetch and is classified without leaking details", async () => {
  const fetchMock: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  const client = new WordstatClient({ ...config, timeoutMs: 10, maxRetries: 0 }, fetchMock);
  const keepEventLoopAlive = setTimeout(() => undefined, 100);
  try {
    await assert.rejects(
      client.top({ phrase: "timeout", numPhrases: 1 }, new AbortController().signal),
      (error: unknown) => error instanceof WordstatError && error.code === "TIMEOUT",
    );
  } finally {
    clearTimeout(keepEventLoopAlive);
  }
});

test("timeout also covers a response body that stops streaming", async () => {
  let bodyCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"totalCount":'));
    },
    cancel() {
      bodyCancelled = true;
    },
  });
  const client = new WordstatClient(
    { ...config, timeoutMs: 10, maxRetries: 0 },
    async () => new Response(body),
  );
  const keepEventLoopAlive = setTimeout(() => undefined, 100);
  try {
    await assert.rejects(
      client.top({ phrase: "body-timeout", numPhrases: 1 }, new AbortController().signal),
      (error: unknown) => error instanceof WordstatError && error.code === "TIMEOUT",
    );
  } finally {
    clearTimeout(keepEventLoopAlive);
  }
  assert.equal(bodyCancelled, true);
});

test("invalid and oversized successful responses are contract errors", async () => {
  const invalid = new WordstatClient(config, async () => new Response("not-json", { status: 200 }));
  await assert.rejects(
    invalid.top({ phrase: "invalid", numPhrases: 1 }, new AbortController().signal),
    (error: unknown) => error instanceof WordstatError && error.code === "UPSTREAM_CONTRACT_ERROR",
  );

  const oversized = new WordstatClient(
    config,
    async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(10 * 1024 * 1024 + 1) },
      }),
  );
  await assert.rejects(
    oversized.top({ phrase: "oversized", numPhrases: 1 }, new AbortController().signal),
    (error: unknown) => error instanceof WordstatError && error.code === "UPSTREAM_CONTRACT_ERROR",
  );

  const invalidUtf8 = new WordstatClient(
    config,
    async () => new Response(new Uint8Array([0xff]), { status: 200 }),
  );
  await assert.rejects(
    invalidUtf8.top({ phrase: "invalid-utf8", numPhrases: 1 }, new AbortController().signal),
    (error: unknown) => error instanceof WordstatError && error.code === "UPSTREAM_CONTRACT_ERROR",
  );
});

test("deduplicated callers have independent cancellation", async () => {
  let calls = 0;
  let resolveFetch: ((response: Response) => void) | undefined;
  const fetchMock: typeof fetch = async () => {
    calls += 1;
    return new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
  };
  const client = new WordstatClient(config, fetchMock);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = client.top({ phrase: "same", numPhrases: 1 }, firstController.signal);
  const second = client.top({ phrase: "same", numPhrases: 1 }, secondController.signal);

  firstController.abort();
  await assert.rejects(
    first,
    (error: unknown) => error instanceof WordstatError && error.code === "CANCELLED",
  );
  resolveFetch?.(Response.json({ totalCount: "1", results: [], associations: [] }));
  const result = await second;
  assert.equal(result.data.totalCount, "1");
  assert.equal(calls, 1);
});

test("underlying deduplicated request is aborted after every caller cancels", async () => {
  let underlyingAborted = false;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const fetchMock: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      markStarted?.();
      signal.addEventListener(
        "abort",
        () => {
          underlyingAborted = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  const client = new WordstatClient(config, fetchMock);
  const controller = new AbortController();
  const request = client.top({ phrase: "cancel", numPhrases: 1 }, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(request, (error: unknown) => error instanceof WordstatError);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(underlyingAborted, true);
});

test("a new caller does not join an aborted deduplicated request", async () => {
  let calls = 0;
  const client = new WordstatClient(config, async () => {
    calls += 1;
    if (calls === 1) return new Promise<Response>(() => undefined);
    return Response.json({ totalCount: "2", results: [], associations: [] });
  });
  const firstController = new AbortController();
  const first = client.top({ phrase: "same", numPhrases: 1 }, firstController.signal);
  firstController.abort();
  await assert.rejects(
    first,
    (error: unknown) => error instanceof WordstatError && error.code === "CANCELLED",
  );

  const second = await client.top({ phrase: "same", numPhrases: 1 }, new AbortController().signal);
  assert.equal(second.data.totalCount, "2");
  assert.equal(calls, 2);
});

test("hourly budget counts started attempts and zero disables it", async () => {
  let limitedCalls = 0;
  const limited = new WordstatClient({ ...config, maxRph: 1 }, async () => {
    limitedCalls += 1;
    return Response.json({ totalCount: "1", results: [], associations: [] });
  });
  await limited.top({ phrase: "first", numPhrases: 1 }, new AbortController().signal);
  await assert.rejects(
    limited.top({ phrase: "second", numPhrases: 1 }, new AbortController().signal),
    (error: unknown) =>
      error instanceof WordstatError && error.code === "RATE_LIMITED" && error.httpAttempts === 0,
  );
  assert.equal(limitedCalls, 1);

  let unlimitedCalls = 0;
  const unlimited = new WordstatClient({ ...config, maxRph: 0 }, async () => {
    unlimitedCalls += 1;
    return Response.json({ totalCount: "1", results: [], associations: [] });
  });
  await unlimited.top({ phrase: "first", numPhrases: 1 }, new AbortController().signal);
  await unlimited.top({ phrase: "second", numPhrases: 1 }, new AbortController().signal);
  assert.equal(unlimitedCalls, 2);
  assert.equal(unlimited.hourlyBudgetRemaining(), null);
});

test("concurrency slot remains occupied until the response body is consumed", async () => {
  let fetchCalls = 0;
  let releaseFirstBody: (() => void) | undefined;
  const firstBody = new ReadableStream<Uint8Array>({
    start(controller) {
      releaseFirstBody = () => {
        controller.enqueue(
          new TextEncoder().encode('{"totalCount":"1","results":[],"associations":[]}'),
        );
        controller.close();
      };
    },
  });
  const fetchMock: typeof fetch = async () => {
    fetchCalls += 1;
    return fetchCalls === 1
      ? new Response(firstBody)
      : Response.json({ totalCount: "2", results: [], associations: [] });
  };
  const client = new WordstatClient({ ...config, maxConcurrency: 1 }, fetchMock);
  const first = client.top({ phrase: "first", numPhrases: 1 }, new AbortController().signal);
  const second = client.top({ phrase: "second", numPhrases: 1 }, new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 1);
  releaseFirstBody?.();
  await first;
  const secondResult = await second;
  assert.equal(secondResult.data.totalCount, "2");
  assert.equal(fetchCalls, 2);
});
