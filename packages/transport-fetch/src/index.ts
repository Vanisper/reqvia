import { createHeaderFields, createHttpError, isHttpError } from "reqvia";
import type { HttpMessage, Transport, TransportControl, TransportRequest } from "reqvia";

/** Fetch 适配器使用的原生能力 */
export interface FetchTransportOptions {
  /** 实际发送请求的 Fetch 实现 */
  readonly fetch: typeof globalThis.fetch;
  /** 每次传输创建独立的取消控制器 */
  readonly createAbortController: () => AbortController;
}

/**
 * 创建使用 Fetch 发送请求的传输实现
 *
 * @description
 * - 响应正文读取完毕后交付报文，HTTP 错误状态仍正常返回
 * - 取消会结束传输等待并通知原生任务，不等待原生实现响应
 * - 所需运行能力由参数提供，不读取全局请求器
 */
export function createFetchTransport(options: FetchTransportOptions): Transport {
  const { fetch: sendFetch, createAbortController } = options;

  return {
    send(request, control) {
      return send(request, control, sendFetch, createAbortController);
    },
  };
}

function transportFailure(cause: unknown) {
  return createHttpError({ kind: "TRANSPORT", cause, message: "Fetch 传输失败" });
}

function send(
  request: TransportRequest,
  control: TransportControl,
  sendFetch: FetchTransportOptions["fetch"],
  createAbortController: FetchTransportOptions["createAbortController"],
): Promise<HttpMessage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    let controller: AbortController | undefined;

    const cleanup = () => {
      const release = unsubscribe;
      unsubscribe = () => {};
      try {
        release();
      } catch {
        // 取消订阅的异常不能阻止本次传输结束
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = () => {
      if (settled) return;
      fail(transportFailure(control.cancellation.reason));
      try {
        controller?.abort(control.cancellation.reason);
      } catch {
        // 物理取消失败时，逻辑等待仍已结束
      }
    };

    try {
      if (control.cancellation.cancelled) {
        cancel();
        return;
      }
      if (["CONNECT", "TRACE", "TRACK"].includes(request.method.toUpperCase())) {
        fail(
          createHttpError({
            kind: "UNSUPPORTED",
            capability: `method:${request.method}`,
            message: "Fetch 不支持该请求方法",
          }),
        );
        return;
      }

      controller = createAbortController();
      unsubscribe = control.cancellation.subscribe(cancel);
      // subscribe 可以同步通知已经发生的取消，此时返回的释放函数仍需执行
      if (settled) {
        cleanup();
        return;
      }

      const init: RequestInit = {
        method: request.method,
        headers: { ...request.headers },
        signal: controller.signal,
      };
      if (request.body) {
        init.body =
          request.body.kind === "text" ? request.body.value : request.body.value.slice().buffer;
      }

      const perform = async (): Promise<HttpMessage | undefined> => {
        let response: Response;
        try {
          response = await sendFetch(request.url, init);
        } catch (cause) {
          throw transportFailure(cause);
        }
        if (settled) {
          discardResponse(response);
          return;
        }
        if (
          response.status === 0 ||
          response.type === "opaque" ||
          response.type === "opaqueredirect"
        ) {
          discardResponse(response);
          throw createHttpError({
            kind: "UNSUPPORTED",
            capability: "observable-response",
            message: "Fetch 响应未暴露可用的 HTTP 报文",
          });
        }

        let payload: HttpMessage["payload"];
        try {
          payload =
            request.representation === "text"
              ? { kind: "text", value: await response.text() }
              : { kind: "bytes", value: new Uint8Array(await response.arrayBuffer()) };
        } catch (cause) {
          throw transportFailure(cause);
        }
        if (settled) return;

        return {
          status: response.status,
          headers: createHeaderFields(headerEntries(response.headers)),
          payload,
          ...(response.url ? { url: response.url } : {}),
        };
      };

      // 两条回调都保留到原生任务结束，消费取消后迟到的拒绝
      void perform().then(
        (message) => {
          if (settled || message === undefined) return;
          settled = true;
          cleanup();
          resolve(message);
        },
        (error: unknown) => {
          fail(isHttpError(error) ? error : transportFailure(error));
        },
      );
    } catch (cause) {
      fail(transportFailure(cause));
    }
  });
}

function discardResponse(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // 已结束调用的清理失败不再改变终态
  }
}

function headerEntries(headers: Headers): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  const cookies = headers.getSetCookie?.();
  let cookiesAdded = false;

  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() === "set-cookie" && cookies !== undefined) {
      if (!cookiesAdded) {
        for (const cookie of cookies) entries.push([name, cookie]);
        cookiesAdded = true;
      }
    } else {
      entries.push([name, value]);
    }
  }
  if (!cookiesAdded && cookies !== undefined) {
    for (const cookie of cookies) entries.push(["set-cookie", cookie]);
  }
  return entries;
}
