export class RingBuffer<T> {
  private readonly items: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    if (this.items.length >= this.capacity) {
      this.items.shift();
    }
    this.items.push(item);
  }

  replace(items: readonly T[]): void {
    this.items.length = 0;
    const start = Math.max(0, items.length - this.capacity);
    for (const item of items.slice(start)) {
      this.items.push(item);
    }
  }

  toArray(): readonly T[] {
    return [...this.items];
  }

  get length(): number {
    return this.items.length;
  }

  get last(): T | undefined {
    return this.items.at(-1);
  }
}
