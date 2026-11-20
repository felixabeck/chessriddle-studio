import type { BestMoves } from "@/bindings";

export const ENGINE_LINE_MEMORY_CAPACITY = 256;

/** Ephemeral per-(tab, engine) memory. Reads do not publish atom updates. */
export class AnalysisLineMemory extends Map<string, BestMoves[]> {
    context: string | null = null;
    private recency = new Set<string>();
    private writers = new Map<string, object>();

    constructor(previous?: Map<string, BestMoves[]>) {
        super();
        if (previous) {
            for (const [key, lines] of previous) this.set(key, lines);
            if (previous instanceof AnalysisLineMemory) {
                this.context = previous.context;
                this.recency = new Set(previous.recency);
                this.writers = new Map(previous.writers);
            }
        }
    }

    override get(key: string) {
        const lines = super.get(key);
        if (lines) this.touch(key);
        return lines;
    }

    private touch(key: string) {
        this.recency.delete(key);
        this.recency.add(key);
    }

    override set(key: string, lines: BestMoves[]) {
        super.set(key, lines);
        this.touch(key);
        this.writers.delete(key);
        if (this.size > ENGINE_LINE_MEMORY_CAPACITY) {
            const oldest = this.recency.keys().next().value!;
            this.delete(oldest);
        }
        return this;
    }

    override delete(key: string) {
        this.recency.delete(key);
        this.writers.delete(key);
        return super.delete(key);
    }

    override clear() {
        super.clear();
        this.recency.clear();
        this.writers.clear();
    }

    /** A restarted search must catch up; its own later payloads may revise depth. */
    remember(key: string, lines: BestMoves[], search: object): boolean {
        const previous = this.get(key);
        if (previous && lines[0].depth < previous[0].depth && this.writers.get(key) !== search) {
            return false;
        }
        this.set(key, lines);
        this.writers.set(key, search);
        return true;
    }
}
