import { createHttpError } from "../core/errors.ts";
import type { EncodedBody, ResponseDecoder, ResponseMeta } from "../core/types.ts";

function decodeFailure(message: string, value: string, meta: ResponseMeta, cause?: unknown) {
  return createHttpError({
    kind: "DECODE",
    message,
    cause,
    response: { ...meta, payload: { kind: "text", value } },
  });
}

function validateContentType(contentType: string): string {
  if (typeof contentType !== "string" || /[\r\n]/.test(contentType)) {
    throw createHttpError({
      kind: "CONFIG",
      field: "contentType",
      message: "正文类型必须是有效头字段值",
    });
  }
  return contentType;
}

/**
 * 将响应文本解析为未知类型的 JSON 值
 *
 * @description 空文本或非法 JSON 产生 DECODE 错误
 */
export function json(): ResponseDecoder<unknown>;
/**
 * 将 JSON 响应交给校验或转换函数
 *
 * @description 结果类型由 parse 推导，parse 抛出的异常原样传播
 */
export function json<T>(parse: (value: unknown) => T | Promise<T>): ResponseDecoder<T>;
export function json<T>(parse?: (value: unknown) => T | Promise<T>): ResponseDecoder<unknown> {
  if (parse !== undefined && typeof parse !== "function") {
    throw createHttpError({ kind: "CONFIG", field: "parse", message: "JSON 校验器必须是函数" });
  }
  return {
    representation: "text",
    decode(value, meta) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(value);
      } catch (cause) {
        throw decodeFailure("响应正文不是有效 JSON", value, meta, cause);
      }
      // 业务校验独立于 JSON 解析的捕获范围，保留其失败语义
      return parse === undefined ? decoded : parse(decoded);
    },
  };
}

/** 返回响应文本，包括空字符串 */
export function text(): ResponseDecoder<string> {
  return { representation: "text", decode: (value) => value };
}

/** 返回响应字节，包括零长度数组 */
export function bytes(): ResponseDecoder<Uint8Array> {
  return { representation: "bytes", decode: (value) => value };
}

/**
 * 确认响应正文为空并返回 null
 *
 * @description 空白字符也属于非空正文，以 DECODE 拒绝
 */
export function empty(): ResponseDecoder<null> {
  return {
    representation: "text",
    decode(value, meta) {
      if (value !== "") {
        throw decodeFailure("响应正文必须为空", value, meta);
      }
      return null;
    },
  };
}

/**
 * 同步编码 JSON 正文
 *
 * @description 序列化失败或无法得到 JSON 文本时抛出 ENCODE，编码不计入请求预算
 */
export function jsonBody(value: unknown): EncodedBody {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (cause) {
    throw createHttpError({ kind: "ENCODE", message: "请求正文无法序列化为 JSON", cause });
  }
  if (encoded === undefined) {
    throw createHttpError({ kind: "ENCODE", message: "请求正文无法得到 JSON 文本" });
  }
  return { payload: { kind: "text", value: encoded }, contentType: "application/json" };
}

/**
 * 构造文本正文
 *
 * @description contentType 用于填补请求中缺失的 Content-Type
 */
export function textBody(value: string, contentType = "text/plain;charset=UTF-8"): EncodedBody {
  if (typeof value !== "string") {
    throw createHttpError({ kind: "CONFIG", field: "body", message: "文本正文必须是字符串" });
  }
  return { payload: { kind: "text", value }, contentType: validateContentType(contentType) };
}

/**
 * 构造字节正文
 *
 * @description 字节在 request 入口复制；调用前对输入数组的修改仍然生效
 */
export function bytesBody(
  value: Uint8Array,
  contentType = "application/octet-stream",
): EncodedBody {
  if (!(value instanceof Uint8Array)) {
    throw createHttpError({ kind: "CONFIG", field: "body", message: "字节正文必须是 Uint8Array" });
  }
  return { payload: { kind: "bytes", value }, contentType: validateContentType(contentType) };
}
