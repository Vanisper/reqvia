import type { HttpError, HttpErrorDetails } from "./types.ts";

const errorBrand = Symbol.for("reqvia.HttpError");

/**
 * 构造带类别与诊断信息的 HTTP 错误
 *
 * @description cause 保留原值；诊断信息不会自动写入日志
 */
export function createHttpError(details: HttpErrorDetails): HttpError {
  const { message, cause, ...fields } = details;
  const error = new Error(message ?? details.kind, { cause });
  error.name = "HttpError";
  Object.assign(error, fields);
  Object.defineProperty(error, errorBrand, { value: true });
  return error as HttpError;
}

/** 判断值是否由 Reqvia 错误工厂构造，不按 kind 或 message 猜测 */
export function isHttpError(value: unknown): value is HttpError {
  if (typeof value !== "object" || value === null) return false;
  try {
    return Reflect.get(value, errorBrand) === true;
  } catch {
    return false;
  }
}
