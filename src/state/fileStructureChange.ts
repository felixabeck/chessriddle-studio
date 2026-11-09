type StructureChange = {
    active: number;
    settled: Promise<void>;
    resolve: () => void;
};

// Structural mutations own these entries. Retain only one entry per file with an active mutation.
const changes = new Map<string, StructureChange>();

/** The owner must release in finally, after publishing or refusing the same-file tab update. */
export function beginFileStructureChange(file: string): () => void {
    let change = changes.get(file);
    if (!change) {
        let resolve!: () => void;
        const settled = new Promise<void>((done) => {
            resolve = done;
        });
        change = { active: 0, settled, resolve };
        changes.set(file, change);
    }
    change.active += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        change.active -= 1;
        if (change.active === 0) {
            changes.delete(file);
            change.resolve();
        }
    };
}

/** Check again after waking, and issue the native call without another asynchronous gap. */
export async function afterFileStructureChange<T>(
    file: string,
    call: () => Promise<T>,
): Promise<T> {
    let change: StructureChange | undefined;
    while ((change = changes.get(file))) await change.settled;
    return call();
}
