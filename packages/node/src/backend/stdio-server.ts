import type { Readable, Writable } from "node:stream";
import { TextDecoder } from "node:util";
import { BackendSession, type BackendSessionOptions } from "./session.js";
import {
  backendResponseError,
  BACKEND_NDJSON_FRAME_LIMIT_BYTES,
  isValidBackendRequestId,
  parseBackendRequest,
  ProtocolError,
  type BackendRequest,
  type BackendResponse
} from "./protocol.js";

export type BackendStdioServerOptions = {
  input: Readable;
  output: Writable;
  error?: Writable;
  session?: BackendSession;
  backendIdentity?: BackendSessionOptions["backendIdentity"];
  maxInFlight?: number;
  frameLimitBytes?: number;
};

const DEFAULT_BACKEND_SERVER_MAX_IN_FLIGHT = 256;
const MAX_BACKEND_SERVER_IN_FLIGHT = 10_000;

export async function runBackendStdioServer(options: BackendStdioServerOptions): Promise<void> {
  validateServerOptions(options);
  const session = options.session ?? new BackendSession(
    options.backendIdentity === undefined ? {} : { backendIdentity: options.backendIdentity }
  );
  const frameLimitBytes = options.frameLimitBytes ?? BACKEND_NDJSON_FRAME_LIMIT_BYTES;
  const maxInFlight = options.maxInFlight ?? DEFAULT_BACKEND_SERVER_MAX_IN_FLIGHT;
  let outputUnavailable = false;
  let correlationViolation = false;
  const writeJson = createJsonLineWriter(options.output, frameLimitBytes, () => {
    outputUnavailable = true;
    // A failed output route cannot safely correlate any later response. Stop
    // reading as soon as the writer detects the failure; the final cleanup
    // below closes the output after already-admitted routes settle.
    options.input.destroy();
  });
  const failClosedOnCorrelationViolation = (): void => {
    if (correlationViolation) return;
    correlationViolation = true;
    // A duplicate active requestId has no safe response route: either caller
    // could observe a frame carrying that id. Stop admitting new input, but
    // leave the already-admitted route alive so its sole terminal response
    // can still settle without being preempted by the duplicate.
    options.input.destroy();
  };
  const activeRequestIds = new Set<string>();
  const tasks = new Set<Promise<void>>();

  try {
    for await (const line of readBoundedNdjsonLines(options.input, frameLimitBytes)) {
      if (outputUnavailable || correlationViolation || !writeJson.isUsable()) break;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      // Check the bounded, already-framed requestId before waiting for an
      // in-flight slot. Otherwise maxInFlight=1 can turn an active duplicate
      // into an apparently valid sequential reuse after the first route
      // settles.
      const preflightRequestId = requestIdFromLine(trimmed);
      if (preflightRequestId !== undefined && activeRequestIds.has(preflightRequestId)) {
        failClosedOnCorrelationViolation();
        break;
      }
      while (tasks.size >= maxInFlight) await waitForTaskSlot(tasks);
      if (outputUnavailable || correlationViolation || !writeJson.isUsable()) break;
      const task = handleLine(
        session,
        trimmed,
        writeJson,
        options.error,
        activeRequestIds,
        failClosedOnCorrelationViolation
      );
      tasks.add(task);
      void task.finally(() => {
        tasks.delete(task);
      }).catch(() => {});
    }
  } catch (caught) {
    if (caught instanceof BackendFrameError) {
      // Once framing is untrusted, no later request can be correlated safely.
      // Close the owned input/output routes so an embedding cannot continue
      // using a partially consumed sidecar.
      options.input.destroy();
      options.output.end();
    }
    if (!correlationViolation) {
      await writeDiagnostic(options.error, caught instanceof BackendFrameError
        ? new Error(caught.message)
        : caught);
    }
  }

  const settled = await Promise.allSettled(tasks);
  const fatalOutput = settled.find(result => result.status === "rejected"
    && result.reason instanceof BackendFrameError);
  if (correlationViolation || fatalOutput?.status === "rejected") {
    options.input.destroy();
    options.output.end();
  }
}

async function handleLine(
  session: BackendSession,
  line: string,
  writeJson: JsonLineWriter,
  error: Writable | undefined,
  activeRequestIds: Set<string>,
  failClosedOnCorrelationViolation: () => void
): Promise<void> {
  let request: BackendRequest | undefined;
  let registeredRequestId: string | undefined;
  try {
    const raw = JSON.parse(line) as unknown;
    const rawRequestId = isRecord(raw) && isValidBackendRequestId(raw.requestId)
      ? raw.requestId
      : undefined;
    if (rawRequestId !== undefined && activeRequestIds.has(rawRequestId)) {
      // Check before protocol parsing too: a malformed duplicate must not
      // fall through to the generic error path and reuse the active id.
      failClosedOnCorrelationViolation();
      return;
    }
    request = parseBackendRequest(raw);
    if (!writeJson.isUsable()) return;
    if (request.requestId !== undefined) {
      if (activeRequestIds.has(request.requestId)) {
        // Never send an error carrying this id: it belongs to the route that
        // was admitted first, and a duplicate response would settle that
        // original caller as if its own route had failed.
        failClosedOnCorrelationViolation();
        return;
      }
      activeRequestIds.add(request.requestId);
      registeredRequestId = request.requestId;
    }
    if (request.command === "runner.stream") {
      for await (const event of session.stream(request)) {
        await writeJson(event);
      }
      return;
    }

    await writeJson(await session.dispatch(request));
  } catch (caught) {
    if (caught instanceof BackendFrameError) throw caught;
    const response = backendResponseError(request?.requestId ?? requestIdFromLine(line), normalizeError(caught));
    await writeJson(response);
    if (!(caught instanceof ProtocolError)) {
      await writeDiagnostic(error, caught);
    }
  } finally {
    if (registeredRequestId !== undefined) activeRequestIds.delete(registeredRequestId);
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof SyntaxError) {
    return new ProtocolError("invalid_request", "Invalid JSON backend request line.", false);
  }
  if (error instanceof Error) return error;
  return new ProtocolError("invalid_request", String(error), false);
}

function requestIdFromLine(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (isRecord(parsed) && isValidBackendRequestId(parsed.requestId)) {
      return parsed.requestId;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

type JsonLineWriter = ((value: BackendResponse | Record<string, unknown>) => Promise<void>) & {
  isUsable: () => boolean;
};

function createJsonLineWriter(
  output: Writable,
  frameLimitBytes: number,
  onFatal: () => void
): JsonLineWriter {
  let tail = Promise.resolve();
  let usable = true;
  let fatalNotified = false;
  const markFatal = (): void => {
    usable = false;
    if (fatalNotified) return;
    fatalNotified = true;
    onFatal();
  };
  const writeJson = (value: BackendResponse | Record<string, unknown>): Promise<void> => {
    const next = tail.then(() => {
      if (!usable) {
        throw new BackendFrameError("backend_invalid_output", "Backend output is unavailable.");
      }
      let line: string;
      try {
        const encoded = JSON.stringify(value);
        if (typeof encoded !== "string") {
          throw new Error("JSON.stringify returned no value.");
        }
        line = encoded;
      } catch {
        const frameError = new BackendFrameError("backend_invalid_output", "Backend response could not be encoded as JSON.");
        markFatal();
        throw frameError;
      }
      // The shared limit is the encoded JSON frame, excluding its NDJSON
      // delimiter.  Keep server output symmetric with both readers.
      if (Buffer.byteLength(line, "utf8") > frameLimitBytes) {
        const frameError = new BackendFrameError("backend_frame_too_large", `Backend output frame exceeds the ${frameLimitBytes} byte limit.`);
        markFatal();
        throw frameError;
      }
      return writeLine(output, `${line}\n`).catch(() => {
        const frameError = new BackendFrameError("backend_invalid_output", "Backend output could not be written.");
        markFatal();
        throw frameError;
      });
    });
    tail = next.catch(() => {});
    return next;
  };
  writeJson.isUsable = () => usable;
  return writeJson;
}

async function writeDiagnostic(error: Writable | undefined, value: unknown): Promise<void> {
  if (error === undefined) return;
  const message = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  await writeLine(error, `${message}\n`);
}

async function writeLine(output: Writable, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      output.off("error", onError);
      if (error !== undefined && error !== null) reject(error);
      else resolve();
    };
    const onError = (error: Error): void => finish(error);
    output.once("error", onError);
    try {
      output.write(line, error => finish(error));
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function waitForTaskSlot(tasks: Set<Promise<void>>): Promise<void> {
  await Promise.race([...tasks].map(task => task.then(() => undefined, () => undefined)));
}

class BackendFrameError extends Error {
  constructor(
    public readonly code: "backend_frame_too_large" | "backend_unterminated_frame" | "backend_invalid_encoding" | "backend_invalid_output",
    message: string
  ) {
    super(message);
    this.name = "BackendFrameError";
  }
}

async function* readBoundedNdjsonLines(input: Readable, limitBytes: number): AsyncIterable<string> {
  let frameBuffer = Buffer.alloc(0);
  let frameBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const newlineIndex = bytes.indexOf(0x0a, offset);
      const segmentEnd = newlineIndex >= 0 ? newlineIndex : bytes.length;
      const segment = bytes.subarray(offset, segmentEnd);
      if (segment.length > 0) {
        const nextFrameBytes = frameBytes + segment.length;
        if (nextFrameBytes > limitBytes) {
          throw new BackendFrameError("backend_frame_too_large", `Backend input frame exceeds the ${limitBytes} byte limit.`);
        }
        if (nextFrameBytes > frameBuffer.length) {
          let nextCapacity = Math.max(frameBuffer.length, 1);
          while (nextCapacity < nextFrameBytes) {
            nextCapacity = Math.min(limitBytes, nextCapacity * 2);
          }
          const grown = Buffer.allocUnsafe(nextCapacity);
          frameBuffer.copy(grown, 0, 0, frameBytes);
          frameBuffer = grown;
        }
        segment.copy(frameBuffer, frameBytes);
        frameBytes = nextFrameBytes;
      }
      if (newlineIndex < 0) break;

      const frame = frameBuffer.subarray(0, frameBytes);
      const body = frame.length > 0 && frame[frame.length - 1] === 0x0d
        ? frame.subarray(0, frame.length - 1)
        : frame;
      try {
        yield decoder.decode(body);
      } catch {
        throw new BackendFrameError("backend_invalid_encoding", "Backend input contained invalid UTF-8.");
      }
      frameBytes = 0;
      offset = newlineIndex + 1;
    }
  }
  if (frameBytes > 0) {
    throw new BackendFrameError("backend_unterminated_frame", "Backend input ended with an unterminated NDJSON frame.");
  }
}

function validateServerOptions(options: BackendStdioServerOptions): void {
  for (const [name, value] of [
    ["maxInFlight", options.maxInFlight],
    ["frameLimitBytes", options.frameLimitBytes]
  ] as const) {
    const max = name === "frameLimitBytes" ? BACKEND_NDJSON_FRAME_LIMIT_BYTES : MAX_BACKEND_SERVER_IN_FLIGHT;
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > max)) {
      throw new TypeError(`Backend stdio option ${name} must be a positive safe integer.`);
    }
  }
}
