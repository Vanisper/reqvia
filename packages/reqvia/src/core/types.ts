/** 合法的 HTTP 方法 token，扩展方法保留大小写 */
export type HttpMethod = string;

/** 查询参数标量；null 和 undefined 在编码时省略 */
export type QueryValue = string | number | boolean | null | undefined;

/** 数组值按原顺序编码为重复的查询键 */
export type QueryInput = Readonly<Record<string, QueryValue | readonly QueryValue[]>>;

/** 请求头输入；名称大小写无关，undefined 删除继承值 */
export type HeaderInput = Readonly<Record<string, string | undefined>>;

/** 已明确表示的正文内容 */
export type Payload =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bytes"; readonly value: Uint8Array };

/** 已编码的请求正文 */
export interface EncodedBody {
  readonly payload: Payload;
  /** 合并后的请求头缺少 Content-Type 时使用的值 */
  readonly contentType?: string;
}

/** 一次 HTTP 请求的输入；调用开始时复制可变容器与字节正文 */
export interface RequestSpec {
  /** 有 baseURL 时使用相对地址，否则使用绝对 HTTP(S) 地址 */
  readonly url: string;
  /** 默认 GET；GET 和 HEAD 不接受显式正文 */
  readonly method?: HttpMethod;
  /** 追加到 URL 现有参数之后，不覆盖同名参数 */
  readonly query?: QueryInput;
  readonly headers?: HeaderInput;
  /** 缺省表示无正文，空字符串或零长度字节仍属于显式正文 */
  readonly body?: EncodedBody;
}

/** 客户端默认值；显式 undefined 保留继承配置 */
export interface ClientDefaults {
  /** 绝对 HTTP(S) 地址，不包含查询、fragment 或用户名密码 */
  readonly baseURL?: string | undefined;
  readonly headers?: HeaderInput | undefined;
  /** 单次调用总预算，默认 30 000 毫秒；0 关闭本库预算 */
  readonly timeoutMs?: number | undefined;
  /** 默认接受 2xx；异常原样传播 */
  readonly acceptStatus?: ((status: number) => boolean) | undefined;
}

/** 当前调用的控制参数，不改变请求描述 */
export interface CallOptions {
  readonly cancellation?: Cancellation | undefined;
  /** 覆盖默认总预算；0 关闭本库预算 */
  readonly timeoutMs?: number | undefined;
  /** 覆盖默认状态判断，不改变解码方式 */
  readonly acceptStatus?: ((status: number) => boolean) | undefined;
}

/** 平台实际可观察的响应头，只读且保留重复条目 */
export interface HeaderFields {
  /** 按大小写无关的名称取得首个值，无匹配时返回 undefined */
  get(name: string): string | undefined;
  /** 取得全部匹配值；返回集合的修改不影响内部状态 */
  getAll(name: string): readonly string[];
  /** 按平台条目顺序迭代，字段名统一为小写 */
  entries(): Iterable<readonly [string, string]>;
}

/** 可交付 HTTP 响应的元信息 */
export interface ResponseMeta {
  readonly status: number;
  readonly headers: HeaderFields;
  /** 平台实际提供的最终响应 URL，无法获取时省略 */
  readonly url?: string;
}

/** 经过解码的响应 */
export interface HttpResponse<T> extends ResponseMeta {
  readonly data: T;
}

/** 响应表示与对应解码函数，输出类型由解码结果决定 */
export type ResponseDecoder<T> =
  | {
      readonly representation: "text";
      /** 只做转换与校验；抛出的异常原样传播 */
      readonly decode: (text: string, meta: ResponseMeta) => T | Promise<T>;
    }
  | {
      readonly representation: "bytes";
      /** 接收平台的二进制正文，不从文本重新编码 */
      readonly decode: (bytes: Uint8Array, meta: ResponseMeta) => T | Promise<T>;
    };

/** 业务接口需要的最小执行能力 */
export interface HttpExecutor {
  /**
   * 执行一次请求并返回普通 Promise
   *
   * @description 至多调用一次传输；状态不被接受时不执行成功解码器
   */
  request<T>(
    spec: RequestSpec,
    decoder: ResponseDecoder<T>,
    options?: CallOptions,
  ): Promise<HttpResponse<T>>;
}

/** 拥有独立默认配置的执行器 */
export interface HttpClient extends HttpExecutor {
  /** 复用同一 Transport，创建独立配置快照；无效默认值同步抛错 */
  derive(defaults: ClientDefaults): HttpClient;
}

/** 只读取消状态，原因保留第一次取消时的值 */
export interface Cancellation {
  readonly cancelled: boolean;
  readonly reason?: unknown;
  /** 已取消时同步通知；返回幂等的取消订阅函数 */
  subscribe(listener: () => void): () => void;
}

/** 由调用方持有的取消控制对象 */
export interface CancellationSource {
  readonly cancellation: Cancellation;
  /** 发出一次取消通知，重复调用无效 */
  cancel(reason?: unknown): void;
}

/** 已完成规范化与正文快照的传输入参 */
export interface TransportRequest {
  readonly url: string;
  readonly method: HttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Payload;
  /** 适配器必须交付同种表示的完整正文 */
  readonly representation: "text" | "bytes";
}

/** 本次传输的控制状态，由执行器持有 */
export interface TransportControl {
  readonly cancellation: Cancellation;
}

/** 中立响应；交付之后适配器不得继续修改其内容 */
export interface HttpMessage extends ResponseMeta {
  readonly payload: Payload;
}

/** 执行器与具体请求实现之间的传输契约 */
export interface Transport {
  /**
   * 发起一次底层请求并交付完整响应
   *
   * @description 4xx 和 5xx 仍返回响应；无法取得完整正文时拒绝
   */
  send(request: TransportRequest, control: TransportControl): Promise<HttpMessage>;
}

/** Reqvia 失败类别及其对应的诊断信息 */
export type HttpErrorDetails = {
  readonly message?: string;
  readonly cause?: unknown;
} & (
  | { readonly kind: "CONFIG"; readonly field: string }
  | { readonly kind: "UNSUPPORTED"; readonly capability: string }
  | { readonly kind: "TRANSPORT" }
  | { readonly kind: "ADAPTER" }
  | { readonly kind: "STATUS"; readonly response: HttpMessage }
  | { readonly kind: "ENCODE" }
  | { readonly kind: "DECODE"; readonly response?: HttpMessage }
  | { readonly kind: "CANCELLED"; readonly reason?: unknown }
  | { readonly kind: "TIMEOUT"; readonly timeoutMs: number }
);

/** Reqvia 自身产生的错误；用户回调的其他异常不会被转换为此类型 */
export type HttpError = Error & HttpErrorDetails & { readonly name: "HttpError" };
