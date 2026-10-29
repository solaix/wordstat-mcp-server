export type WordstatErrorCode =
  | "CONFIGURATION_ERROR"
  | "AUTHENTICATION_ERROR"
  | "AUTHORIZATION_ERROR"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_CONTRACT_ERROR"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "CANCELLED";

export class WordstatError extends Error {
  readonly code: WordstatErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly httpAttempts: number | undefined;

  constructor(
    code: WordstatErrorCode,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      retryAfterSeconds?: number;
      httpAttempts?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "WordstatError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.httpAttempts = options.httpAttempts;
  }
}

export function withHttpAttempts(error: WordstatError, httpAttempts: number): WordstatError {
  return new WordstatError(error.code, error.message, {
    ...(error.status === undefined ? {} : { status: error.status }),
    retryable: error.retryable,
    ...(error.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: error.retryAfterSeconds }),
    httpAttempts,
    cause: error,
  });
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof WordstatError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "The request was cancelled";
  return "Unexpected Wordstat server error";
}
