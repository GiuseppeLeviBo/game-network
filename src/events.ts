import type { Unsubscribe } from "./protocol.js";

export class EventSlot<TArgs extends unknown[]> {
  private readonly handlers = new Set<(...args: TArgs) => void>();

  subscribe(handler: (...args: TArgs) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(...args: TArgs): void {
    for (const handler of [...this.handlers]) {
      handler(...args);
    }
  }
}

