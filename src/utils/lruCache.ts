/**
 * A map bounded at `capacity` entries that drops the least recently used entry first. `get` and
 * `set` count as uses; `has` does not.
 */
export class LruCache<K, V> {
    private readonly entries = new Map<K, V>();

    constructor(readonly capacity: number) {
        if (!Number.isInteger(capacity) || capacity < 1)
            throw new RangeError(`LruCache capacity must be a positive integer, got ${capacity}`);
    }

    get size() {
        return this.entries.size;
    }

    /** The value for `key`, which becomes the most recently used entry. */
    get(key: K): V | undefined {
        if (!this.entries.has(key)) return undefined;
        const value = this.entries.get(key) as V;
        this.entries.delete(key);
        this.entries.set(key, value);
        return value;
    }

    has(key: K) {
        return this.entries.has(key);
    }

    /** Stores `value` as the most recently used entry and drops the least recently used one above capacity. */
    set(key: K, value: V) {
        this.entries.delete(key);
        this.entries.set(key, value);
        if (this.entries.size > this.capacity) {
            const oldest = this.entries.keys().next();
            if (!oldest.done) this.entries.delete(oldest.value);
        }
    }

    clear() {
        this.entries.clear();
    }
}
