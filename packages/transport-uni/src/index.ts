import { createHeaderFields, createHttpError, isHttpError } from "reqvia";
import type { HttpMessage, Transport, TransportControl, TransportRequest } from "reqvia";
import type {
  UniRequestMethod,
  UniRequestResponse,
  UniRequestTask,
  UniTransportOptions,
} from "./types.ts";

export type {
  UniRequestMethod,
  UniRequestOptions,
  UniRequestResponse,
  UniRequestTask,
  UniTransportCapabilities,
  UniTransportOptions,
} from "./types.ts";

const methods = new Set(["GET", "POST", "PUT", "DELETE", "CONNECT", "HEAD", "OPTIONS", "TRACE"]);

/**
 * 创建使用 uni.request 回调与任务取消能力的传输实现
 *
 * @description
 * - 不支持的方法或二进制能力在发起请求前拒绝
 * - 平台交付完整正文后返回报文，HTTP 错误状态仍正常返回
 * - 取消会结束等待并调用任务的 abort，不等待原生取消回调
 */
export function createUniTransport(options: UniTransportOptions): Transport {
  if (typeof options?.request !== "function") {
    throw createHttpError({ kind: "CONFIG", field: "request" });
  }
  const capabilities = options.capabilities;
  if (
    !capabilities ||
    !Array.isArray(capabilities.methods) ||
    capabilities.methods.some((method) => !methods.has(method)) ||
    typeof capabilities.requestBytes !== "boolean" ||
    typeof capabilities.responseBytes !== "boolean"
  ) {
    throw createHttpError({ kind: "CONFIG", field: "capabilities" });
  }
  const allowedMethods = new Set<string>(capabilities.methods);
  const { requestBytes, responseBytes } = capabilities;
  const sendRequest = options.request;
  return {
    send(request, control) {
      return send(request, control, sendRequest, allowedMethods, requestBytes, responseBytes);
    },
  };
}

function transportFailure(cause: unknown) {
  return createHttpError({ kind: "TRANSPORT", cause, message: "UniApp 传输失败" });
}

function send(
  request: TransportRequest,
  control: TransportControl,
  sendRequest: UniTransportOptions["request"],
  allowedMethods: ReadonlySet<string>,
  requestBytes: boolean,
  responseBytes: boolean,
): Promise<HttpMessage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    let task: UniRequestTask | undefined;
    let abortRequested = false;
    let aborted = false;
    const cleanup = () => {
      const release = unsubscribe;
      unsubscribe = () => {};
      try {
        release();
      } catch {
        // 释放失败不能改变已确定的终态
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => {
      if (!task || aborted) return;
      aborted = true;
      try {
        task.abort();
      } catch {
        // 原生任务拒绝停止时，外层等待仍然可以结束
      }
    };
    const cancel = () => {
      if (settled) return;
      abortRequested = true;
      fail(transportFailure(control.cancellation.reason));
      abort();
    };
    try {
      if (control.cancellation.cancelled) {
        cancel();
        return;
      }
      const unsupported = !allowedMethods.has(request.method)
        ? `method:${request.method}`
        : request.body?.kind === "bytes" && !requestBytes
          ? "request:bytes"
          : request.representation === "bytes" && !responseBytes
            ? "response:bytes"
            : undefined;
      if (unsupported) {
        fail(createHttpError({ kind: "UNSUPPORTED", capability: unsupported }));
        return;
      }
      unsubscribe = control.cancellation.subscribe(cancel);
      // 已取消的订阅可以同步通知，返回的释放函数仍需执行
      if (settled) {
        cleanup();
        return;
      }
      task = sendRequest({
        url: request.url,
        method: request.method as UniRequestMethod,
        header: { ...request.headers },
        dataType: "text",
        responseType: request.representation === "bytes" ? "arraybuffer" : "text",
        ...(request.body
          ? {
              data:
                request.body.kind === "text"
                  ? request.body.value
                  : request.body.value.slice().buffer,
            }
          : {}),
        success(response) {
          if (settled) return;
          try {
            const message = readMessage(response, request.representation);
            settled = true;
            cleanup();
            resolve(message);
          } catch (cause) {
            fail(isHttpError(cause) ? cause : createHttpError({ kind: "ADAPTER", cause }));
          }
        },
        fail(cause) {
          fail(transportFailure(cause));
        },
      });
      // request 返回前可能同步触发取消；任务句柄到达后补上物理取消
      if (abortRequested) abort();
      if (!task || typeof task.abort !== "function") {
        fail(createHttpError({ kind: "ADAPTER", message: "uni.request 未返回可取消任务" }));
      }
    } catch (cause) {
      fail(transportFailure(cause));
    }
  });
}

function readMessage(response: UniRequestResponse, representation: "text" | "bytes"): HttpMessage {
  if (
    !response ||
    !Number.isInteger(response.statusCode) ||
    response.statusCode < 200 ||
    response.statusCode > 599
  ) {
    throw createHttpError({ kind: "ADAPTER", message: "UniApp 返回了无效状态码" });
  }
  const data = response.data;
  let payload: HttpMessage["payload"];
  if (representation === "text" && typeof data === "string") {
    payload = { kind: "text", value: data };
  } else if (representation === "bytes" && data instanceof ArrayBuffer) {
    payload = { kind: "bytes", value: new Uint8Array(data.slice(0)) };
  } else {
    throw createHttpError({ kind: "ADAPTER", message: "UniApp 响应正文与请求表示不一致" });
  }
  if (!response.header || typeof response.header !== "object" || Array.isArray(response.header)) {
    throw createHttpError({ kind: "ADAPTER", message: "UniApp 返回了无效响应头" });
  }
  const entries: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(response.header)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== "string") {
        throw createHttpError({ kind: "ADAPTER", message: "UniApp 响应头值必须是字符串" });
      }
      entries.push([name, item]);
    }
  }
  return { status: response.statusCode, headers: createHeaderFields(entries), payload };
}
