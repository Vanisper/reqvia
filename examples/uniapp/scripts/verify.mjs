import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { startExampleServer } from "@reqvia/example-server";
import { withBrowser } from "@reqvia/example-server/browser";

const directory = fileURLToPath(new URL("../dist/build/h5/", import.meta.url));
const development = process.argv.includes("--dev");
const server = development
  ? await startDevelopmentServer()
  : await startExampleServer({ serveDirectory: directory });
const requests = async () => {
  const response = await fetch(`${server.origin}/__state`);
  return (await response.json()).requests;
};
let checks = 0;

async function startDevelopmentServer() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const require = createRequire(import.meta.url);
  const child = spawn(
    process.execPath,
    [
      require.resolve("@dcloudio/vite-plugin-uni/bin/uni.js"),
      "--config",
      "uni.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await exited;
    clearTimeout(force);
  };
  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Uni 开发服务退出：${output}`);
      try {
        return (await fetch(`${origin}/__state`)).ok;
      } catch {
        return false;
      }
    }, 30_000);
    return { origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}
const selector = (id) => `[data-testid="${id}"]`;

async function waitFor(check, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("服务端未观察到预期请求状态");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

try {
  await withBrowser(server.origin, async (page) => {
    await page.waitFor(
      `document.querySelector('${selector("status")}')?.getAttribute('data-state') === 'ready'`,
    );
    assert.equal(
      await page.evaluate(`document.querySelectorAll('${selector("user-name")}').length`),
      2,
    );
    checks++;

    await page.click(selector("detail-42"));
    await page.waitFor(
      `document.querySelector('${selector("detail-name")}')?.textContent === '林舟'`,
    );
    checks++;
    await page.click(selector("back"));
    await page.waitFor(
      `document.querySelector('${selector("status")}')?.getAttribute('data-state') === 'ready'`,
    );

    const beforeDetail = (await requests()).filter(
      (request) => request.path === "/api/users/slow",
    ).length;
    // H5 hash 导航会卸载详情，这里验证取消与重新进入
    await page.evaluate("location.hash = '/pages/detail/index?id=slow'");
    await waitFor(
      async () =>
        (await requests()).filter((request) => request.path === "/api/users/slow").length ===
        beforeDetail + 1,
    );
    await page.evaluate("location.hash = '/pages/users/index'");
    await waitFor(
      async () =>
        (await requests()).filter((request) => request.path === "/api/users/slow")[beforeDetail]
          ?.aborted,
    );
    await page.evaluate("history.back()");
    await page.waitFor(
      `document.querySelector('${selector("detail-name")}')?.textContent === '林舟'`,
    );
    const detailRequests = (await requests())
      .filter((request) => request.path === "/api/users/slow")
      .slice(beforeDetail);
    assert.equal(detailRequests.length, 2, "首次进入和再次进入各发起一次详情请求");
    assert.equal(detailRequests[0].aborted, true);
    assert.equal(detailRequests[1].completed, true);
    checks++;
    await page.click(selector("back"));
    await page.waitFor(
      `document.querySelector('${selector("status")}')?.getAttribute('data-state') === 'ready'`,
    );

    const beforeRapid = (await requests()).length;
    await page.click(selector("slow"));
    await page.waitFor(
      `document.querySelector('${selector("status")}')?.getAttribute('data-state') === 'loading'`,
    );
    await waitFor(async () =>
      (await requests()).slice(beforeRapid).some((request) => request.query === "slow"),
    );
    await page.click(selector("fast"));
    await page.waitFor(
      `document.querySelector('${selector("status")}')?.getAttribute('data-state') === 'ready'`,
    );
    await waitFor(async () =>
      (await requests())
        .slice(beforeRapid)
        .some((request) => request.query === "slow" && request.aborted),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      await page.evaluate(`document.querySelector('${selector("user-name")}')?.textContent`),
      "陈希",
    );
    checks++;

    await page.click(selector("invalid"));
    await page.waitFor(
      `document.querySelector('${selector("error")}')?.getAttribute('data-kind') === 'DomainValidationError'`,
    );
    checks++;
    await page.click(selector("failure"));
    await page.waitFor(
      `document.querySelector('${selector("error")}')?.getAttribute('data-kind') === 'STATUS'`,
    );
    checks++;

    const beforeCancel = (await requests()).length;
    await page.click(selector("hang"));
    await page.waitFor(
      `document.querySelector('${selector("status")}')?.getAttribute('data-state') === 'loading'`,
    );
    await waitFor(async () =>
      (await requests()).slice(beforeCancel).some((request) => request.query === "hang"),
    );
    await page.click(selector("cancel"));
    await page.waitFor(
      `document.querySelector('${selector("status")}')?.getAttribute('data-state') === 'cancelled'`,
    );
    await waitFor(async () =>
      (await requests())
        .slice(beforeCancel)
        .some((request) => request.query === "hang" && request.aborted),
    );
    checks++;

    const beforeLeave = (await requests()).length;
    await page.click(selector("hang"));
    await page.waitFor(
      `document.querySelector('${selector("status")}')?.getAttribute('data-state') === 'loading'`,
    );
    await waitFor(async () =>
      (await requests()).slice(beforeLeave).some((request) => request.query === "hang"),
    );
    await page.click(selector("leave"));
    await page.waitFor(
      `document.querySelector('${selector("detail-name")}')?.textContent === '林舟'`,
    );
    await waitFor(async () =>
      (await requests())
        .slice(beforeLeave)
        .some((request) => request.query === "hang" && request.aborted),
    );
    checks++;
    assert.equal(
      await page.evaluate("typeof URL === 'function' && Number.isFinite(performance.now())"),
      true,
    );
    checks++;
  });
  console.log(
    `UniApp H5 ${development ? "开发" : "生产"}消费验证通过：${checks} 项，标准 Uni 编译工程与真实浏览器`,
  );
} finally {
  await server.close();
}
