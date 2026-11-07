/** uni.request 接受的方法；具体可用范围由目标端声明 */
export type UniRequestMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "CONNECT"
  | "HEAD"
  | "OPTIONS"
  | "TRACE";

/** uni.request 成功回调中使用的原生字段 */
export interface UniRequestResponse {
  /** 原始文本或 ArrayBuffer，适配器会检查实际表示 */
  readonly data: unknown;
  readonly statusCode: number;
  /** 仅复制平台暴露的头字段，不从 cookies 等旁路字段补造 */
  readonly header: object;
}

/** 适配器传给 uni.request 的回调式参数 */
export interface UniRequestOptions {
  readonly url: string;
  readonly method: UniRequestMethod;
  readonly header: Record<string, string>;
  readonly data?: string | ArrayBuffer;
  /** 关闭平台自动 JSON 解析 */
  readonly dataType: "text";
  readonly responseType: "text" | "arraybuffer";
  readonly success: (response: UniRequestResponse) => void;
  readonly fail: (error: unknown) => void;
}

/** 回调式 uni.request 返回的任务能力 */
export interface UniRequestTask {
  /** 请求停止底层工作；适配器不等待后续回调 */
  abort(): void;
}

/** 当前目标端经过确认的传输能力 */
export interface UniTransportCapabilities {
  /** 允许发送的方法；未列出的方法在调用原生请求之前拒绝 */
  readonly methods: readonly UniRequestMethod[];
  /** 是否可以原样发送 ArrayBuffer 正文 */
  readonly requestBytes: boolean;
  /** 是否可以使用 responseType: arraybuffer 读取响应 */
  readonly responseBytes: boolean;
}

/** 创建 UniApp 适配器所需的原生能力与目标约束 */
export interface UniTransportOptions {
  /** 回调式请求函数，必须返回可取消的任务 */
  readonly request: (options: UniRequestOptions) => UniRequestTask;
  /** 创建时复制，不自动探测运行平台 */
  readonly capabilities: UniTransportCapabilities;
}
