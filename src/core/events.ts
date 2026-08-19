/**
 * 极简类型安全事件总线。
 * 不依赖第三方库，容量小、无副作用，足够中枢与 UI 解耦使用。
 */

export type Listener<E> = (event: E) => void;

export class EventBus<E extends { type: string }> {
  private listeners = new Set<Listener<E>>();

  /** 订阅全部事件，返回退订函数 */
  subscribe(listener: Listener<E>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 按 type 过滤订阅 */
  subscribeType<T extends E["type"]>(
    type: T,
    listener: (event: Extract<E, { type: T }>) => void,
  ): () => void {
    return this.subscribe((event) => {
      if (event.type === type) {
        listener(event as Extract<E, { type: T }>);
      }
    });
  }

  emit(event: E): void {
    // 复制一份再遍历，允许监听器在回调中增删订阅
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  get size(): number {
    return this.listeners.size;
  }
}