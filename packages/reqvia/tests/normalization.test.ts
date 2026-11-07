import { describe, expect, test } from "vite-plus/test";
import { bytesBody, textBody } from "../src/codec/index.ts";
import { createHttpError, isHttpError } from "../src/core/errors.ts";
import { createHeaderFields } from "../src/core/headers.ts";
import { normalizeDefaults, normalizeRequest, validateTimeout } from "../src/core/normalize.ts";
import type { ClientDefaults, HeaderInput, QueryInput } from "../src/core/types.ts";

describe("请求规范化", () => {
  const defaults = normalizeDefaults({ baseURL: "https://api.example.com/v1/" });

  test.each([
    ["users", "https://api.example.com/v1/users"],
    ["/users", "https://api.example.com/users"],
    ["../users", "https://api.example.com/users"],
  ])("按标准相对地址解析 %s", (url, expected) => {
    expect(normalizeRequest({ url }, defaults, "text").url).toBe(expected);
  });

  test("保留既有查询编码并按顺序追加原始参数", () => {
    const request = normalizeRequest(
      {
        url: "users?existing=a%20b&slash=%2f#section",
        query: { q: ["一 二", "%2f"], skip: null, flag: false, zero: 0 },
      },
      defaults,
      "text",
    );
    expect(request.url).toBe(
      "https://api.example.com/v1/users?existing=a%20b&slash=%2f&q=%E4%B8%80%20%E4%BA%8C&q=%252f&flag=false&zero=0",
    );
  });

  test("baseURL 末尾斜杠保留标准语义", () => {
    expect(
      normalizeRequest(
        { url: "users" },
        normalizeDefaults({ baseURL: "https://api.example.com/v1" }),
        "text",
      ).url,
    ).toBe("https://api.example.com/users");
  });

  test.each([
    "https://api.example.com/absolute",
    "https://other.example.com/",
    "//api.example.com/",
    "\\\\other.example.com/",
    "/\\other.example.com/",
    " \n//other.example.com/",
    "h\tttps://api.example.com/",
  ])("有基地址时拒绝绝对地址与主机切换 %s", (url) => {
    expect(() => normalizeRequest({ url }, defaults, "text")).toThrow(
      expect.objectContaining({ kind: "CONFIG", field: "url" }),
    );
  });

  test.each(["/relative", "ftp://example.com/", "https://user@example.com/"])(
    "无基地址时拒绝不符合绝对 HTTP 地址契约的 %s",
    (url) => {
      expect(() => normalizeRequest({ url }, normalizeDefaults({}), "text")).toThrow(
        expect.objectContaining({ kind: "CONFIG", field: "url" }),
      );
    },
  );

  test.each(["https://example.com/?", "https://example.com/#", "https://user@example.com/"])(
    "基地址不能包含查询、fragment 或凭证 %s",
    (baseURL) => {
      expect(() => normalizeDefaults({ baseURL })).toThrow(
        expect.objectContaining({ kind: "CONFIG", field: "baseURL" }),
      );
    },
  );

  test.each([Number.NaN, Infinity, { nested: true }, ["nested"]])("拒绝非法查询值 %s", (value) => {
    expect(() =>
      normalizeRequest(
        { url: "users", query: { q: [value] } as unknown as QueryInput },
        defaults,
        "text",
      ),
    ).toThrow(expect.objectContaining({ kind: "CONFIG", field: "query" }));
  });

  test("规范常用方法并保留扩展方法的大小写", () => {
    expect(normalizeRequest({ url: "users", method: "post" }, defaults, "text").method).toBe(
      "POST",
    );
    expect(normalizeRequest({ url: "users", method: "custom" }, defaults, "text").method).toBe(
      "custom",
    );
    expect(() =>
      normalizeRequest({ url: "users", method: "bad method" }, defaults, "text"),
    ).toThrow(expect.objectContaining({ kind: "CONFIG", field: "method" }));
  });

  test("派生配置合并头字段并保持父子快照独立", () => {
    const input = { authorization: "old", accept: "application/json" };
    const parent = normalizeDefaults({ headers: input, timeoutMs: 5_000 });
    const child = normalizeDefaults(
      { headers: { Authorization: undefined, Accept: "text/plain" }, timeoutMs: undefined },
      parent,
    );
    input.authorization = "changed";
    expect(parent.headers.authorization).toBe("old");
    expect(child.headers).toEqual({ accept: "text/plain" });
    expect(child.timeoutMs).toBe(5_000);
    expect(parent.headers.accept).toBe("application/json");
  });

  test.each([
    { Foo: "one", foo: "two" },
    { "bad name": "value" },
    { foo: "line\r\nbreak" },
    { foo: 1 } as unknown as HeaderInput,
  ])("无效请求头在传输前拒绝", (headers) => {
    expect(() => normalizeRequest({ url: "users", headers }, defaults, "text")).toThrow(
      expect.objectContaining({ kind: "CONFIG", field: "headers" }),
    );
  });

  test("请求正文和配置在同步规范化时固定", () => {
    const body = new Uint8Array([1, 2]);
    const query = { q: ["before"] };
    const headers = { accept: "application/json" };
    const request = normalizeRequest(
      { url: "users", method: "POST", query, headers, body: bytesBody(body) },
      defaults,
      "text",
    );
    body[0] = 9;
    query.q[0] = "after";
    headers.accept = "text/plain";
    expect(request.url).toBe("https://api.example.com/v1/users?q=before");
    expect(request.headers.accept).toBe("application/json");
    expect(request.body).toEqual({ kind: "bytes", value: new Uint8Array([1, 2]) });
    expect(request.representation).toBe("text");
  });

  test("正文提示填补被删除的 Content-Type，显式值仍然优先", () => {
    const parent = normalizeDefaults({
      baseURL: "https://api.example.com/",
      headers: { "Content-Type": "application/json" },
    });
    const spec = { url: "users", method: "POST", body: textBody("data") };
    expect(
      normalizeRequest({ ...spec, headers: { "content-type": undefined } }, parent, "bytes")
        .headers["content-type"],
    ).toBe("text/plain;charset=UTF-8");
    expect(
      normalizeRequest(
        { ...spec, headers: { "content-type": "application/custom" } },
        parent,
        "bytes",
      ).headers["content-type"],
    ).toBe("application/custom");
  });

  test.each(["GET", "HEAD"])("%s 即使显式正文为空也拒绝", (method) => {
    expect(() =>
      normalizeRequest({ url: "users", method, body: textBody("") }, defaults, "text"),
    ).toThrow(expect.objectContaining({ kind: "CONFIG", field: "body" }));
  });

  test.each([-1, NaN, Infinity, null, "100"])("拒绝无效预算 %s", (value) => {
    expect(() => validateTimeout(value)).toThrow(expect.objectContaining({ kind: "CONFIG" }));
    expect(() => normalizeDefaults({ timeoutMs: value } as ClientDefaults)).toThrow(
      expect.objectContaining({ kind: "CONFIG" }),
    );
  });

  test("零预算与有限小数合法", () => {
    expect(validateTimeout(0)).toBe(0);
    expect(validateTimeout(0.5)).toBe(0.5);
  });
});

describe("中立响应头与错误", () => {
  test("响应头复制原始条目，保留重复项和顺序", () => {
    const entries: Array<[string, string]> = [
      ["X-Value", "first"],
      ["x-value", "second, third"],
    ];
    const fields = createHeaderFields(entries);
    entries[0][1] = "changed";
    expect(fields.get("X-VALUE")).toBe("first");
    expect(fields.getAll("x-value")).toEqual(["first", "second, third"]);
    expect(fields.get("missing")).toBeUndefined();
    expect(fields.getAll("missing")).toEqual([]);
    expect([...fields.entries()]).toEqual([
      ["x-value", "first"],
      ["x-value", "second, third"],
    ]);
    expect(() => (fields.getAll("x-value") as string[]).push("mutated")).toThrow();
    expect(() => (([...fields.entries()][0] as unknown as string[])[1] = "mutated")).toThrow();
    expect(fields.get("x-value")).toBe("first");
  });

  test("无效响应头和中途失败的迭代器归 ADAPTER", () => {
    expect(() => createHeaderFields([["bad name", "value"]])).toThrow(
      expect.objectContaining({ kind: "ADAPTER" }),
    );
    const cause = new Error("迭代中断");
    function* broken(): Iterable<readonly [string, string]> {
      yield ["ok", "value"];
      throw cause;
    }
    expect(() => createHeaderFields(broken())).toThrow(
      expect.objectContaining({ kind: "ADAPTER", cause }),
    );
  });

  test("错误工厂保留原因并通过品牌识别", () => {
    const cause = { detail: "connection closed" };
    const failure = createHttpError({ kind: "TRANSPORT", cause });
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe("TRANSPORT");
    expect(failure.cause).toBe(cause);
    expect(isHttpError(failure)).toBe(true);
    expect(isHttpError(Object.assign(new Error("TRANSPORT"), { kind: "TRANSPORT" }))).toBe(false);
    expect(isHttpError(null)).toBe(false);
  });
});
