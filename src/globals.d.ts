/**
 * 全局调试句柄类型声明（window.__app）。
 */
import type { __App } from './apphook';

declare global {
  interface Window {
    __app: __App;
  }
}

export {};
