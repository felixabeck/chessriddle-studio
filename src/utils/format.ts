export function formatNumber(value?: number): string {
    if (!value) return "0";
    return Intl.NumberFormat().format(value);
}

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;
// Months and years are approximations for display.
const DAYS_PER_MONTH = 30;
const MONTHS_PER_YEAR = 12;
const SECONDS_PER_MONTH = DAYS_PER_MONTH * SECONDS_PER_DAY;
const SECONDS_PER_YEAR = MONTHS_PER_YEAR * SECONDS_PER_MONTH;

export function formatRelativeTime(time: number, now: number, locale: string): string {
    const seconds = (time - now) / MILLISECONDS_PER_SECOND;
    const magnitude = Math.abs(seconds);
    const [unit, divisor]: [Intl.RelativeTimeFormatUnit, number] =
        magnitude < SECONDS_PER_MINUTE
            ? ["second", 1]
            : magnitude < SECONDS_PER_HOUR
              ? ["minute", SECONDS_PER_MINUTE]
              : magnitude < SECONDS_PER_DAY
                ? ["hour", SECONDS_PER_HOUR]
                : magnitude < SECONDS_PER_MONTH
                  ? ["day", SECONDS_PER_DAY]
                  : magnitude < SECONDS_PER_YEAR
                    ? ["month", SECONDS_PER_MONTH]
                    : ["year", SECONDS_PER_YEAR];
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
        Math.trunc(seconds / divisor),
        unit,
    );
}

export function formatBytes(bytes: bigint | number | string, decimals = 2) {
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];

    const value = Number(bytes);
    const i =
        value === 0 ? 0 : Math.min(Math.floor(Math.log(value) / Math.log(k)), sizes.length - 1);

    return `${Number.parseFloat((value / k ** i).toFixed(dm))} ${sizes[i]}`;
}

/** "12." before a White move, "12..." before a Black one; `halfMoves` is the ply the move completes. */
export function formatMoveNumber(halfMoves: number): string {
    return `${Math.ceil(halfMoves / 2)}${halfMoves % 2 === 1 ? "." : "..."}`;
}

export function capitalize(str: string) {
    return `${str.charAt(0).toUpperCase()}${str.slice(1)}`;
}

export function formatThemeLabel(theme: string) {
    const normalized = theme
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
        .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
        .trim();

    if (!normalized) return theme;

    return normalized
        .split(" ")
        .filter(Boolean)
        .map((word) => {
            if (/^\d+$/.test(word)) return word;
            return capitalize(word.toLowerCase());
        })
        .join(" ");
}

export function formatNodes(nodes: number | bigint, decimals = 0) {
    const units = ["", "k", "M", "B", "T"];
    let i = 0;
    let value = Number(nodes);

    while (value >= 1000 && i < units.length - 1) {
        value /= 1000;
        i++;
    }

    return `${value.toFixed(decimals)}${units[i]}`;
}

export function formatTime(ms: number) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const tenths = Math.floor((ms % 1000) / 100);
    if (minutes > 0) {
        return `${minutes}:${seconds.toString().padStart(2, "0")}.${tenths}`;
    }
    return `${seconds}.${tenths}s`;
}

export function getInitials(name: string) {
    const names = name.split(" ");
    const initials = names.map((n) => n.charAt(0).toUpperCase()).join("");
    return initials;
}

export function roundKeepSum(numbers: number[], targetSum = 100): number[] {
    if (numbers.every((num) => num === 0)) return numbers;
    const mappedNumbers = numbers.map((num, i) => ({
        originalValue: num,
        decimalPart: num - Math.floor(num),
        index: i,
        flooredValue: Math.floor(num),
    }));

    const currentSum = mappedNumbers.reduce((sum, item) => sum + item.flooredValue, 0);

    const remainder = Math.round(targetSum - currentSum);

    mappedNumbers.sort((a, b) => b.decimalPart - a.decimalPart);

    for (let i = 0; i < remainder; i++) {
        mappedNumbers[i].flooredValue += 1;
    }

    return mappedNumbers.sort((a, b) => a.index - b.index).map((item) => item.flooredValue);
}
