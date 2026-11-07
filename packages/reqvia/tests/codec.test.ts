import { describe, expect, expectTypeOf, test, vi } from "vite-plus/test";
import { bytes, bytesBody, empty, json, jsonBody, text, textBody } from "../src/codec/index.ts";
import { createHeaderFields } from "../src/core/headers.ts";
import type { ResponseDecoder, ResponseMeta } from "../src/core/types.ts";

function metadata(): ResponseMeta {
  return { status: 200, headers: createHeaderFields([]), url: "https://example.test/users" };
}

function decodeText<T>(decoder: ResponseDecoder<T>, value: string): T | Promise<T> {
  if (decoder.representation !== "text") {
    throw new Error("测试需要文本解码器");
  }
  return decoder.decode(value, metadata());
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("预期操作抛出异常");
}

describe("响应解码", () => {
  test("JSON 默认返回未知值，并由校验函数推导同步或异步结果", async () => {
    expectTypeOf(json()).toEqualTypeOf<ResponseDecoder<unknown>>();
    const parse = vi.fn((value: unknown) => ({ count: Number(value) }));
    const decoder = json(parse);
    expectTypeOf(decoder).toEqualTypeOf<ResponseDecoder<{ count: number }>>();
    expect(decodeText(decoder, "42")).toEqual({ count: 42 });
    expect(parse).toHaveBeenCalledWith(42);
    const asyncDecoder = json(async (value: unknown) => String(value));
    expectTypeOf(asyncDecoder).toEqualTypeOf<ResponseDecoder<string>>();
    await expect(decodeText(asyncDecoder, "null")).resolves.toBe("null");
  });

  test.each(["", " ", "{broken", "undefined"])("非法 JSON %j 保留响应与解析原因", (value) => {
    const parse = vi.fn();
    const error = caught(() => decodeText(json(parse), value));
    expect(error).toMatchObject({
      kind: "DECODE",
      cause: expect.any(SyntaxError),
      response: { status: 200, payload: { kind: "text", value } },
    });
    expect(parse).not.toHaveBeenCalled();
  });

  test("业务校验的同步抛错与异步拒绝保持原值", async () => {
    const failure = { business: "invalid-user" };
    const syncDecoder = json(() => {
      throw failure;
    });
    const asyncDecoder = json(() => Promise.reject(failure));
    expect(caught(() => decodeText(syncDecoder, "{}"))).toBe(failure);
    await expect(decodeText(asyncDecoder, "{}")).rejects.toBe(failure);
  });

  test("文本保留空值与字符，空响应只接受零长度文本", () => {
    expect(decodeText(text(), "")).toBe("");
    expect(decodeText(text(), "\u0000汉字\n")).toBe("\u0000汉字\n");
    expectTypeOf(empty()).toEqualTypeOf<ResponseDecoder<null>>();
    expect(decodeText(empty(), "")).toBeNull();
    expect(caught(() => decodeText(empty(), "\n"))).toMatchObject({ kind: "DECODE" });
    expect(caught(() => decodeText(empty(), "null"))).toMatchObject({ kind: "DECODE" });
  });

  test("字节解码保持二进制数据和零长度数组", () => {
    const decoder = bytes();
    if (decoder.representation !== "bytes") {
      throw new Error("测试需要字节解码器");
    }
    const value = new Uint8Array([0, 128, 255]);
    expect(decoder.decode(value, metadata())).toBe(value);
    expect(decoder.decode(new Uint8Array(), metadata())).toHaveLength(0);
  });
});

describe("正文编码", () => {
  test("JSON 在构造正文时编码，保留标准 JSON 转换规则", () => {
    const input = { name: "林舟", skipped: undefined };
    const body = jsonBody(input);
    input.name = "已修改";
    expect(body).toEqual({
      payload: { kind: "text", value: '{"name":"林舟"}' },
      contentType: "application/json",
    });
    expect(jsonBody(null).payload).toEqual({ kind: "text", value: "null" });
  });

  test.each([undefined, Symbol("missing"), () => 1])("无法编码顶层值时同步抛出 ENCODE", (value) => {
    expect(caught(() => jsonBody(value))).toMatchObject({ kind: "ENCODE" });
  });

  test("序列化循环对象或 bigint 失败，并保留原始原因", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(caught(() => jsonBody(cyclic))).toMatchObject({
      kind: "ENCODE",
      cause: expect.any(TypeError),
    });
    expect(caught(() => jsonBody(1n))).toMatchObject({
      kind: "ENCODE",
      cause: expect.any(TypeError),
    });
    const cause = new Error("toJSON failed");
    expect(
      caught(() =>
        jsonBody({
          toJSON: () => {
            throw cause;
          },
        }),
      ),
    ).toMatchObject({ kind: "ENCODE", cause });
  });

  test("文本与字节正文使用独立的类型提示且允许空值", () => {
    expect(textBody("")).toEqual({
      payload: { kind: "text", value: "" },
      contentType: "text/plain;charset=UTF-8",
    });
    expect(textBody("a,b", "text/csv").contentType).toBe("text/csv");
    const value = new Uint8Array();
    expect(bytesBody(value)).toEqual({
      payload: { kind: "bytes", value },
      contentType: "application/octet-stream",
    });
    expect(bytesBody(value, "application/pdf").contentType).toBe("application/pdf");
  });

  test("无效正文类型或换行的 Content-Type 在构造时拒绝", () => {
    expect(caught(() => textBody(12 as unknown as string))).toMatchObject({ kind: "CONFIG" });
    expect(caught(() => bytesBody([] as unknown as Uint8Array))).toMatchObject({ kind: "CONFIG" });
    expect(caught(() => textBody("value", "text/plain\r\nx-header: value"))).toMatchObject({
      kind: "CONFIG",
      field: "contentType",
    });
  });
});
