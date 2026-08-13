import type { IRuntime } from "./IRuntime";
import { MockRuntime } from "./mock/MockRuntime";
import { DshRuntime } from "./dsh/DshRuntime";

export type RuntimeKind = "mock" | "dsh";

export interface CreateRuntimeOptions {
  /**
   * 运行时选择：
   *   - mock：纯前端模拟，无外部依赖，默认用于 UI 调试 / CI
   *   dsh ：真实 @deepseek-ai/dsh SDK，需要在 settings 中配置有效 API Key
   */
  kind?: RuntimeKind;
  /** 通过 Tauri 启动参数注入（MOCK_RUNTIME=1 时强制 mock） */
  forceMock?: boolean;
}

const SINGLETON_LOCK = { current: null as IRuntime | null };

export function createRuntime(opts: CreateRuntimeOptions = {}): IRuntime {
  if (SINGLETON_LOCK.current) return SINGLETON_LOCK.current;
  const forceMock = opts.forceMock ?? (typeof import.meta !== "undefined" && import.meta.env?.VITE_MOCK_RUNTIME === "1");
  const kind: RuntimeKind = opts.kind ?? (forceMock ? "mock" : "dsh");
  const runtime: IRuntime = kind === "mock" ? new MockRuntime() : new DshRuntime();
  SINGLETON_LOCK.current = runtime;
  return runtime;
}

export function getRuntime(): IRuntime {
  if (!SINGLETON_LOCK.current) {
    throw new Error("Runtime not created. Call createRuntime() first.");
  }
  return SINGLETON_LOCK.current;
}

export function __resetRuntimeForTests(): void {
  SINGLETON_LOCK.current = null;
}
