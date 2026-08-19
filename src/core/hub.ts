/**
 * 中枢（Hub）：插件注册 + 统一调用入口 + 事件总线。
 * 心智模型：Hub 只负责「编排」，不负责具体业务 —— 业务全在插件里。
 */
import type {
  Capability,
  CapabilityContext,
  Hub as HubInterface,
  HubEvent,
  Provider,
} from "./types";
import { EventBus } from "./events";
import { Registry } from "./registry";

export class Hub implements HubInterface {
  readonly capabilities = new Registry<Capability>();
  readonly providers = new Registry<Provider>();
  readonly events = new EventBus<HubEvent>();

  private ctxCache = new Map<string, CapabilityContext>();

  /** 注册能力（插件）并触发其 onRegister 回调 */
  registerCapability(cap: Capability): void {
    this.capabilities.register(cap);
    const ctx = this.contextFor(cap.id);
    void cap.onRegister?.(ctx);
    this.events.emit({ type: "capability:registered", capabilityId: cap.id });
  }

  registerProvider(p: Provider): void {
    this.providers.register(p);
  }

  /** 能力扩展统一调用入口：call(capabilityId, action, payload) */
  async call<T = unknown>(capabilityId: string, action: string, payload?: unknown): Promise<T> {
    const cap = this.capabilities.get(capabilityId);
    if (!cap) {
      throw new Error(`[Hub] 能力不存在: ${capabilityId}`);
    }
    if (typeof cap.execute !== "function") {
      throw new Error(`[Hub] 能力「${cap.id}」未实现 execute: ${capabilityId}`);
    }
    return cap.execute(this.contextFor(cap.id), action, payload) as Promise<T>;
  }

  /** 给插件分配上下文（同一插件复用同一实例，避免反复创建） */
  private contextFor(capabilityId: string): CapabilityContext {
    let ctx = this.ctxCache.get(capabilityId);
    if (!ctx) {
      ctx = {
        hub: this,
        emit: (event) => this.events.emit(event),
        subscribe: (listener) => this.events.subscribe(listener),
      };
      this.ctxCache.set(capabilityId, ctx);
    }
    return ctx;
  }
}