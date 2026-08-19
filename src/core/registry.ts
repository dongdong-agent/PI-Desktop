/**
 * 通用注册表：管理一类带 id 的插件（Capability / Provider / 将来的 Skill）。
 * 所有插件注册都走这里，保证「扩展 = 注册」，不散落全局变量。
 */

export class Registry<T extends { id: string }> {
  private items = new Map<string, T>();
  private listeners = new Set<(changed: "register" | "unregister", item: T) => void>();

  register(item: T): void {
    if (this.items.has(item.id)) {
      throw new Error(`[Registry] 重复注册: ${item.id}`);
    }
    this.items.set(item.id, item);
    for (const l of [...this.listeners]) l("register", item);
  }

  unregister(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    this.items.delete(id);
    for (const l of [...this.listeners]) l("unregister", item);
    return true;
  }

  get<U extends T = T>(id: string): U | undefined {
    return this.items.get(id) as U | undefined;
  }

  list(): T[] {
    return [...this.items.values()];
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  clear(): void {
    for (const id of [...this.items.keys()]) {
      this.unregister(id);
    }
  }

  /** 订阅注册表变化（供 UI 动态刷新列表） */
  subscribe(listener: (changed: "register" | "unregister", item: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get size(): number {
    return this.items.size;
  }
}