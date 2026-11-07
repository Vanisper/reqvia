/// <reference types="@dcloudio/types" />

declare module "@dcloudio/uni-h5" {
  /** 官方 H5 运行时没有附带声明，使用同源 uni.request 声明检查注入接口 */
  export const request: Uni["request"];
}
