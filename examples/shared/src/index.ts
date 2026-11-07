import { json } from "reqvia";
import type { CallOptions, HttpExecutor } from "reqvia";

/** 消费示例中的用户资料 */
export interface User {
  readonly id: string;
  readonly name: string;
  readonly role: string;
}

/** 响应不满足本例用户模型时产生的领域错误 */
export class DomainValidationError extends Error {
  constructor() {
    super("用户响应格式无效");
    this.name = "DomainValidationError";
  }
}

/** 校验用户响应并复制领域字段 */
export function parseUser(value: unknown): User {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    !("role" in value) ||
    typeof value.role !== "string" ||
    value.role.length === 0
  ) {
    throw new DomainValidationError();
  }
  return { id: value.id, name: value.name, role: value.role };
}

/** 校验列表及每个用户，任一非法记录使整个列表失败 */
export function parseUsers(value: unknown): readonly User[] {
  if (!Array.isArray(value)) throw new DomainValidationError();
  return value.map(parseUser);
}

/** 三个消费端共用的业务接口，仅依赖请求执行能力 */
export class UserService {
  private readonly http: HttpExecutor;

  constructor(http: HttpExecutor) {
    this.http = http;
  }

  /** 按关键字查询用户，将调用控制参数传递给执行器 */
  async list(query = "", options?: CallOptions): Promise<readonly User[]> {
    const { data } = await this.http.request(
      { url: "users", query: { query } },
      json(parseUsers),
      options,
    );
    return data;
  }

  /** 查询指定用户，响应格式不符时保留领域校验错误 */
  async find(id: string, options?: CallOptions): Promise<User> {
    const { data } = await this.http.request(
      { url: `users/${encodeURIComponent(id)}` },
      json(parseUser),
      options,
    );
    return data;
  }
}
