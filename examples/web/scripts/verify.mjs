import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startExampleServer } from "@reqvia/example-server";
import { withBrowser } from "@reqvia/example-server/browser";

const server = await startExampleServer({
  serveDirectory: fileURLToPath(new URL("../dist/", import.meta.url)),
});
let checks = 0;

async function waitForRequest(query, predicate) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate(server.requests.filter((entry) => entry.query === query))) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`未观察到 ${query} 请求的预期状态`);
}

try {
  await withBrowser(server.origin, async (page) => {
    const check = async (name, action) => {
      await action();
      checks++;
      console.log(`通过：${name}`);
    };
    const search = async (query) => {
      await page.fill('[data-testid="search-input"]', query);
      await page.click('[data-testid="search-submit"]');
    };
    await check("页面使用共享 Service 读取用户列表", async () => {
      await page.waitFor('document.querySelectorAll("[data-testid=user-list] li").length === 2');
      assert.match(
        await page.evaluate('document.querySelector("[data-testid=user-list]").textContent'),
        /林舟/,
      );
    });
    await check("选择用户读取独立详情", async () => {
      await page.click('[data-testid="user-42"]');
      await page.waitFor(
        'document.querySelector("[data-testid=detail-name]")?.textContent === "林舟"',
      );
      await page.click('[data-testid="close-detail"]');
      await page.waitFor('document.querySelector("[data-testid=detail-name]") === null');
    });
    await check("无匹配结果显示空状态", async () => {
      await search("不存在的成员");
      await page.waitFor(
        'document.querySelector("[data-testid=empty-list]") !== null && !document.querySelector("[data-testid=loading]")',
      );
    });
    await check("领域校验错误原文到达页面", async () => {
      await search("invalid");
      await page.waitFor(
        'document.querySelector("[data-testid=list-error]")?.textContent === "用户响应格式无效"',
      );
    });
    await check("HTTP 失败结束加载并显示错误", async () => {
      await search("error");
      await page.waitFor(
        'document.querySelector("[data-testid=list-error]") !== null && !document.querySelector("[data-testid=loading]")',
      );
      assert.notEqual(
        await page.evaluate('document.querySelector("[data-testid=list-error]").textContent'),
        "用户响应格式无效",
      );
    });
    await check("快速切换查询保留最新结果并取消旧连接", async () => {
      await search("slow");
      await waitForRequest("slow", (requests) => requests.length > 0);
      await search("fast");
      await page.waitFor(
        'document.querySelector("[data-testid=user-43]") !== null && !document.querySelector("[data-testid=loading]")',
      );
      await waitForRequest("slow", (requests) => requests.some((request) => request.aborted));
      await page.evaluate("new Promise(resolve => setTimeout(resolve, 450))");
      assert.equal(
        await page.evaluate('document.querySelector("[data-testid=user-42]") === null'),
        true,
      );
    });
    await check("手动取消结束等待并关闭底层连接", async () => {
      const previous = server.requests.filter((request) => request.query === "hang").length;
      await search("hang");
      await waitForRequest("hang", (requests) => requests.length > previous);
      await page.click('[data-testid="search-cancel"]');
      await page.waitFor(
        'document.querySelector("[data-testid=notice]")?.textContent === "查询已取消"',
      );
      await waitForRequest("hang", (requests) => requests[previous]?.aborted);
    });
    await check("离开目录释放请求，重新进入可继续使用", async () => {
      const previous = server.requests.filter((request) => request.query === "hang").length;
      await search("hang");
      await waitForRequest("hang", (requests) => requests.length > previous);
      await page.click('[data-testid="leave-directory"]');
      await page.waitFor('document.querySelector("[data-testid=welcome]") !== null');
      await waitForRequest("hang", (requests) => requests[previous]?.aborted);
      await page.click('[data-testid="open-directory"]');
      await page.waitFor('document.querySelectorAll("[data-testid=user-list] li").length === 2');
    });
    await check("页面导航释放正在执行的请求", async () => {
      const previous = server.requests.filter((request) => request.query === "hang").length;
      const previousInitial = server.requests.filter((request) => request.query === "").length;
      await search("hang");
      await waitForRequest("hang", (requests) => requests.length > previous);
      await page.click('[data-testid="home-link"]');
      await waitForRequest("hang", (requests) => requests[previous]?.aborted);
      await waitForRequest("", (requests) => requests.length > previousInitial);
      await page.waitFor('document.querySelectorAll("[data-testid=user-list] li").length === 2');
    });
  });
  console.log(`Web 消费端验证通过：${checks} 项真实页面操作与网络检查`);
} finally {
  await server.close();
}
