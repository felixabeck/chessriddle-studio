import i18n from "@/i18n";

type StructureChange = {
    active: number;
    settled: Promise<void>;
    resolve: () => void;
};

// Structural mutations own these entries. Retain only one entry per file with an active mutation.
const changes = new Map<string, StructureChange>();

// Open flows retain one count per file from the first read through tab admission.
const opens = new Map<string, number>();

export class StaleFileGameError extends Error {
    constructor() {
        super(i18n.t("Files.LineSection.Stale"));
        this.name = "StaleFileGameError";
    }
}

export function hasFileOpenInFlight(file: string): boolean {
    return opens.has(file);
}

/** The owner must release in finally, after tab admission succeeds or fails. */
export function beginFileOpen(file: string): () => void {
    if (changes.has(file)) throw new StaleFileGameError();
    opens.set(file, (opens.get(file) ?? 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const remaining = opens.get(file)! - 1;
        if (remaining === 0) opens.delete(file);
        else opens.set(file, remaining);
    };
}

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
