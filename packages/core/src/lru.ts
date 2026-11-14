/**
 * A least-recently-used cache on a `Map`, which iterates in insertion order: a hit is moved to the
 * end by deleting and re-inserting it, so the first key is always the least recently used.
 */
export class LruCache<K, V> {
  readonly #entries = new Map<K, V>();

  constructor(readonly capacity: number) {
    if (!(Number.isInteger(capacity) && capacity > 0)) {
      throw new RangeError(`LruCache: capacity must be a positive integer, got ${capacity}`);
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    if (!this.#entries.has(key)) return undefined;
    const value = this.#entries.get(key) as V;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  /** The value for `key` without marking it as used. */
  peek(key: K): V | undefined {
    return this.#entries.get(key);
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.capacity) this.#entries.delete(this.#entries.keys().next().value as K);
  }

  delete(key: K): void {
    this.#entries.delete(key);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }
}
