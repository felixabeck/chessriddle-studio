export function isPrefix<T>(shorter: T[], longer: T[]): boolean {
    if (shorter.length > longer.length) {
        return false;
    }
    for (let i = 0; i < shorter.length; i++) {
        if (shorter[i] !== longer[i]) {
            return false;
        }
    }
    return true;
}

export function* takeWhile<T>(
    collection: Iterable<T>,
    condition: (item: T) => boolean,
): Generator<T> {
    for (const item of collection) {
        if (condition(item)) yield item;
        else break;
    }
}

export function* skipWhile<T>(
    collection: Iterable<T>,
    condition: (item: T) => boolean,
): Generator<T> {
    let conditionBroken = false;
    for (const item of collection) {
        if (!conditionBroken && !condition(item)) {
            conditionBroken = true;
        }
        if (conditionBroken) {
            yield item;
        }
    }
}

export function mean(arr: number[]): number {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function harmonicMean(arr: number[]): number {
    const sum = arr.reduce((a, b) => a + 1 / Math.max(1, b), 0);
    return arr.length / sum;
}
