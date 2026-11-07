import { createHttpError, isHttpError } from "./errors.ts";
import type { HeaderFields } from "./types.ts";

export const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** 复制并校验响应头；非法条目同步抛出 ADAPTER */
export function createHeaderFields(entries: Iterable<readonly [string, string]>): HeaderFields {
  const snapshot: Array<readonly [string, string]> = [];
  try {
    for (const entry of entries) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        !HTTP_TOKEN.test(entry[0]) ||
        typeof entry[1] !== "string" ||
        /[\r\n]/.test(entry[1])
      ) {
        throw createHttpError({ kind: "ADAPTER", message: "响应头条目无效" });
      }
      snapshot.push(Object.freeze([entry[0].toLowerCase(), entry[1]] as const));
    }
  } catch (cause) {
    if (isHttpError(cause) && cause.kind === "ADAPTER") throw cause;
    throw createHttpError({ kind: "ADAPTER", message: "无法读取响应头", cause });
  }
  const frozenEntries = Object.freeze(snapshot);

  return Object.freeze({
    get(name: string): string | undefined {
      const normalized = name.toLowerCase();
      return frozenEntries.find(([key]) => key === normalized)?.[1];
    },
    getAll(name: string): readonly string[] {
      const normalized = name.toLowerCase();
      return Object.freeze(
        frozenEntries.filter(([key]) => key === normalized).map(([, value]) => value),
      );
    },
    entries(): Iterable<readonly [string, string]> {
      return frozenEntries;
    },
  });
}
