// 有界 Map：超过容量后按插入顺序淘汰最旧条目（用于步骤缓冲与幂等键）
export class BoundedMap<K, V> {
  private map = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error('capacity must be >= 1');
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // 读取刷新为最新（LRU）
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  values(): V[] {
    return [...this.map.values()];
  }

  clear(): void {
    this.map.clear();
  }
}
