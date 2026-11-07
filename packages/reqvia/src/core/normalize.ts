import { createHttpError } from "./errors.ts";
import { HTTP_TOKEN } from "./headers.ts";
import type {
  ClientDefaults,
  HeaderInput,
  Payload,
  QueryInput,
  RequestSpec,
  TransportRequest,
} from "./types.ts";

export interface NormalizedDefaults {
  readonly baseURL?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly acceptStatus: (status: number) => boolean;
}

const standardMethods = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "CONNECT",
  "TRACE",
]);

function invalid(field: string, message: string, cause?: unknown): never {
  throw createHttpError({ kind: "CONFIG", field, message, cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseURL(value: unknown, field: string, baseURL?: string): URL {
  if (typeof value !== "string") invalid(field, "URL 必须为字符串");
  let url: URL;
  try {
    url = new URL(value, baseURL);
  } catch (cause) {
    invalid(field, "URL 无法解析", cause);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    invalid(field, "URL 仅支持 HTTP(S)");
  }
  if (url.username || url.password) invalid(field, "URL 不能包含用户名或密码");
  return url;
}

function normalizeBaseURL(value: unknown): string {
  const url = parseURL(value, "baseURL");
  if (url.href.includes("?") || url.href.includes("#")) {
    invalid("baseURL", "baseURL 不能包含查询或 fragment");
  }
  return url.href;
}

function mergeHeaders(
  inherited: Readonly<Record<string, string>>,
  input?: HeaderInput,
): Record<string, string> {
  const result: Record<string, string> = Object.assign(Object.create(null), inherited);
  if (input === undefined) return result;
  if (!isRecord(input)) invalid("headers", "请求头必须为普通记录");
  const names = new Set<string>();
  for (const [name, value] of Object.entries(input)) {
    if (!HTTP_TOKEN.test(name)) invalid("headers", "请求头名称无效");
    const normalized = name.toLowerCase();
    if (names.has(normalized)) invalid("headers", "同层请求头名称不能仅大小写不同");
    names.add(normalized);
    if (value === undefined) {
      delete result[normalized];
    } else {
      if (typeof value !== "string" || /[\r\n]/.test(value)) {
        invalid("headers", "请求头值必须是不含换行的字符串");
      }
      result[normalized] = value;
    }
  }
  return result;
}

export function validateTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalid("timeoutMs", "时间预算必须为非负有限数");
  }
  return value;
}

export function normalizeDefaults(
  input: ClientDefaults,
  parent?: NormalizedDefaults,
): NormalizedDefaults {
  if (!isRecord(input as unknown)) invalid("defaults", "默认配置必须为普通记录");
  const baseURL = input.baseURL === undefined ? parent?.baseURL : normalizeBaseURL(input.baseURL);
  const timeoutMs = validateTimeout(
    input.timeoutMs === undefined ? (parent?.timeoutMs ?? 30_000) : input.timeoutMs,
  );
  const acceptStatus =
    input.acceptStatus === undefined
      ? (parent?.acceptStatus ?? ((status: number) => status >= 200 && status <= 299))
      : input.acceptStatus;
  if (typeof acceptStatus !== "function") {
    invalid("acceptStatus", "状态判断必须为函数");
  }
  return Object.freeze({
    ...(baseURL === undefined ? {} : { baseURL }),
    headers: Object.freeze(mergeHeaders(parent?.headers ?? {}, input.headers)),
    timeoutMs,
    acceptStatus,
  });
}

function appendQuery(url: URL, query: QueryInput | undefined): void {
  if (query === undefined) return;
  if (!isRecord(query)) invalid("query", "查询参数必须为普通记录");
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === undefined || item === null) continue;
      if (
        typeof item !== "string" &&
        typeof item !== "boolean" &&
        !(typeof item === "number" && Number.isFinite(item))
      ) {
        invalid("query", "查询值必须为字符串、有限数字或布尔值");
      }
      try {
        pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(item))}`);
      } catch (cause) {
        invalid("query", "查询参数无法编码", cause);
      }
    }
  }
  // 修改 searchParams 会重写已有转义形式，追加时保留原始查询片段
  if (pairs.length > 0) {
    url.search = `${url.search ? `${url.search}&` : "?"}${pairs.join("&")}`;
  }
}

function snapshotBody(input: unknown): { body: Payload; contentType?: string } {
  if (!isRecord(input) || !isRecord(input.payload)) {
    invalid("body", "请求正文必须为已编码内容");
  }
  const contentType = input.contentType;
  if (
    contentType !== undefined &&
    (typeof contentType !== "string" || /[\r\n]/.test(contentType))
  ) {
    invalid("body.contentType", "Content-Type 必须是不含换行的字符串");
  }
  const { kind, value } = input.payload;
  let body: Payload;
  if (kind === "text" && typeof value === "string") {
    body = Object.freeze({ kind, value });
  } else if (kind === "bytes" && value instanceof Uint8Array) {
    body = Object.freeze({ kind, value: new Uint8Array(value) });
  } else {
    invalid("body.payload", "正文表示与内容不匹配");
  }
  return { body, ...(contentType === undefined ? {} : { contentType }) };
}

export function normalizeRequest(
  spec: RequestSpec,
  defaults: NormalizedDefaults,
  representation: "text" | "bytes",
): TransportRequest {
  if (!isRecord(spec)) invalid("request", "请求描述必须为普通记录");
  if (representation !== "text" && representation !== "bytes") {
    invalid("decoder.representation", "响应表示必须为 text 或 bytes");
  }
  const inputMethod = spec.method === undefined ? "GET" : spec.method;
  if (typeof inputMethod !== "string" || !HTTP_TOKEN.test(inputMethod)) {
    invalid("method", "HTTP 方法必须为有效 token");
  }
  const method = standardMethods.has(inputMethod.toUpperCase())
    ? inputMethod.toUpperCase()
    : inputMethod;
  const inputURL = spec.url;
  if (typeof inputURL !== "string") invalid("url", "URL 必须为字符串");
  if (defaults.baseURL !== undefined) {
    // 与标准 URL 解析一致地处理控制字符与反斜线，拒绝主机切换
    const reference = inputURL
      .replace(/[\t\n\r]/g, "")
      // oxlint-disable-next-line no-control-regex -- URL 解析会忽略首尾 C0 控制字符
      .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "")
      .replace(/\\/g, "/");
    if (/^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith("//")) {
      invalid("url", "配置 baseURL 后请求必须使用相对地址");
    }
  }
  const url = parseURL(inputURL, "url", defaults.baseURL);
  if (defaults.baseURL !== undefined && url.origin !== new URL(defaults.baseURL).origin) {
    invalid("url", "请求地址不能切换到 baseURL 之外的 origin");
  }
  url.hash = "";
  appendQuery(url, spec.query);
  const headers = mergeHeaders(defaults.headers, spec.headers);
  const encoded = spec.body === undefined ? undefined : snapshotBody(spec.body);
  if (encoded !== undefined && (method === "GET" || method === "HEAD")) {
    invalid("body", "GET 和 HEAD 不接受显式正文");
  }
  if (encoded?.contentType !== undefined && headers["content-type"] === undefined) {
    headers["content-type"] = encoded.contentType;
  }
  return Object.freeze({
    url: url.href,
    method,
    headers: Object.freeze(headers),
    ...(encoded === undefined ? {} : { body: encoded.body }),
    representation,
  });
}
