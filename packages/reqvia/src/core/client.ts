import { createCancellation } from "./cancellation.ts";
import { createHttpError, isHttpError } from "./errors.ts";
import { createHeaderFields } from "./headers.ts";
import { normalizeDefaults, normalizeRequest, validateTimeout } from "./normalize.ts";
import type { NormalizedDefaults } from "./normalize.ts";
import type {
  CallOptions,
  Cancellation,
  ClientDefaults,
  HttpClient,
  HttpMessage,
  HttpResponse,
  RequestSpec,
  ResponseDecoder,
  ResponseMeta,
  Transport,
} from "./types.ts";

/**
 * 创建执行单次 HTTP 调用的客户端
 *
 * @description 默认配置在创建时固定；无效配置同步抛出 CONFIG，请求失败通过 Promise 传播
 */
export function createHttpClient(
  options: ClientDefaults & { readonly transport: Transport },
): HttpClient {
  if (!options || typeof options !== "object" || typeof options.transport?.send !== "function") {
    throw createHttpError({ kind: "CONFIG", field: "transport" });
  }
  const transport = { send: options.transport.send.bind(options.transport) };
  return createClient(transport, normalizeDefaults(options));
}

function createClient(transport: Transport, defaults: NormalizedDefaults): HttpClient {
  return Object.freeze({
    request<T>(spec: RequestSpec, decoder: ResponseDecoder<T>, options?: CallOptions) {
      return execute(transport, defaults, spec, decoder, options);
    },
    derive(input: ClientDefaults) {
      return createClient(transport, normalizeDefaults(input, defaults));
    },
  });
}

type Outcome<T> = { ok: true; value: HttpResponse<T> } | { ok: false; error: unknown };

function execute<T>(
  transport: Transport,
  defaults: NormalizedDefaults,
  spec: RequestSpec,
  inputDecoder: ResponseDecoder<T>,
  options: CallOptions = {},
): Promise<HttpResponse<T>> {
  const started = performance.now();

  return new Promise((resolve, reject) => {
    const control = createCancellation();
    let cancellation: Cancellation | undefined;
    let timeoutMs = defaults.timeoutMs;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};

    function interruption() {
      if (timeoutMs > 0 && performance.now() - started >= timeoutMs) {
        return createHttpError({ kind: "TIMEOUT", timeoutMs });
      }
      if (cancellation?.cancelled) {
        return createHttpError({ kind: "CANCELLED", reason: cancellation.reason });
      }
      return undefined;
    }

    function finish(outcome: Outcome<T>) {
      if (settled) return;
      const interrupted = interruption();
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        unsubscribe();
      } catch {
        // 外部取消实现的清理异常不能替换已经确定的调用结果
      }
      if (interrupted) {
        control.cancel(interrupted);
        reject(interrupted);
      } else if (outcome.ok) {
        resolve(outcome.value);
      } else {
        reject(outcome.error);
      }
    }

    function checkpoint() {
      if (settled) return true;
      const error = interruption();
      if (!error) return false;
      finish({ ok: false, error });
      return true;
    }

    function armTimer() {
      if (timeoutMs === 0 || checkpoint()) return;
      const remaining = timeoutMs - (performance.now() - started);
      // 分段等待，避免宿主把超过 32 位范围的延迟截成极短计时器
      timer = setTimeout(
        () => {
          timer = undefined;
          if (!checkpoint()) armTimer();
        },
        Math.max(1, Math.min(Math.ceil(remaining), 2_147_483_647)),
      );
    }

    try {
      if (!options || typeof options !== "object") {
        throw createHttpError({ kind: "CONFIG", field: "options" });
      }
      timeoutMs = validateTimeout(
        options.timeoutMs === undefined ? defaults.timeoutMs : options.timeoutMs,
      );
      cancellation = options.cancellation;
      if (
        cancellation !== undefined &&
        (!cancellation ||
          typeof cancellation.cancelled !== "boolean" ||
          typeof cancellation.subscribe !== "function")
      ) {
        cancellation = undefined;
        throw createHttpError({ kind: "CONFIG", field: "cancellation" });
      }
      const acceptStatus =
        options.acceptStatus === undefined ? defaults.acceptStatus : options.acceptStatus;
      if (typeof acceptStatus !== "function") {
        throw createHttpError({ kind: "CONFIG", field: "acceptStatus" });
      }
      const decoder = snapshotDecoder(inputDecoder);
      const request = normalizeRequest(spec, defaults, decoder.representation);
      if (checkpoint()) return;

      if (cancellation) {
        const release = cancellation.subscribe(() => checkpoint());
        if (typeof release !== "function") {
          throw createHttpError({ kind: "CONFIG", field: "cancellation.subscribe" });
        }
        // subscribe 允许同步通知，终态可能已在拿到清理函数之前提交
        if (settled) {
          release();
          return;
        }
        unsubscribe = release;
      }
      armTimer();
      if (checkpoint()) return;

      // 独立持有外层 Promise，传输或解码永不结束也不阻挡取消和超时
      void (async () => {
        let raw: HttpMessage;
        try {
          raw = await transport.send(request, { cancellation: control.cancellation });
        } catch (cause) {
          finish({ ok: false, error: transportError(cause) });
          return;
        }
        if (checkpoint()) return;
        try {
          const message = validateMessage(raw, decoder.representation);
          if (checkpoint()) return;
          const accepted = acceptStatus(message.status);
          if (typeof accepted !== "boolean") {
            throw createHttpError({ kind: "CONFIG", field: "acceptStatus" });
          }
          if (checkpoint()) return;
          if (!accepted) {
            throw createHttpError({ kind: "STATUS", response: message });
          }
          const meta: ResponseMeta = Object.freeze({
            status: message.status,
            headers: message.headers,
            ...(message.url === undefined ? {} : { url: message.url }),
          });
          let data: T;
          if (decoder.representation === "text" && message.payload.kind === "text") {
            data = await decoder.decode(message.payload.value, meta);
          } else if (decoder.representation === "bytes" && message.payload.kind === "bytes") {
            data = await decoder.decode(message.payload.value, meta);
          } else {
            throw createHttpError({ kind: "ADAPTER" });
          }
          finish({ ok: true, value: Object.freeze({ ...meta, data }) });
        } catch (error) {
          finish({ ok: false, error });
        }
      })();
    } catch (error) {
      finish({ ok: false, error });
    }
  });
}

function snapshotDecoder<T>(decoder: ResponseDecoder<T>): ResponseDecoder<T> {
  if (!decoder || typeof decoder !== "object" || typeof decoder.decode !== "function") {
    throw createHttpError({ kind: "CONFIG", field: "decoder" });
  }
  if (decoder.representation === "text") {
    return { representation: "text", decode: decoder.decode.bind(decoder) };
  }
  if (decoder.representation === "bytes") {
    return { representation: "bytes", decode: decoder.decode.bind(decoder) };
  }
  throw createHttpError({ kind: "CONFIG", field: "decoder.representation" });
}

function validateMessage(message: HttpMessage, representation: "text" | "bytes"): HttpMessage {
  try {
    if (
      !message ||
      typeof message !== "object" ||
      !Number.isInteger(message.status) ||
      message.status < 200 ||
      message.status > 599 ||
      (message.url !== undefined && typeof message.url !== "string") ||
      !message.headers ||
      typeof message.headers.entries !== "function" ||
      !message.payload ||
      message.payload.kind !== representation ||
      (message.payload.kind === "text" && typeof message.payload.value !== "string") ||
      (message.payload.kind === "bytes" && !(message.payload.value instanceof Uint8Array))
    ) {
      throw new TypeError("传输响应不符合报文契约");
    }
    return Object.freeze({
      status: message.status,
      headers: createHeaderFields(message.headers.entries()),
      payload: Object.freeze({ ...message.payload }),
      ...(message.url === undefined ? {} : { url: message.url }),
    });
  } catch (cause) {
    throw createHttpError({ kind: "ADAPTER", cause });
  }
}

function transportError(cause: unknown) {
  if (isHttpError(cause)) {
    if (["UNSUPPORTED", "TRANSPORT", "ADAPTER"].includes(cause.kind)) return cause;
    return createHttpError({ kind: "ADAPTER", cause });
  }
  return createHttpError({ kind: "TRANSPORT", cause });
}
