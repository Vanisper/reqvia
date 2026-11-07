import type { IncomingMessage, ServerResponse } from "node:http";

/** 创建本地验收路由；返回 false 时由后续中间件处理 */
export function createApiHandler(): (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;
