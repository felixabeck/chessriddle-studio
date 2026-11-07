import type { DailyStatsData } from "@/bindings";
import dayjs from "dayjs";

export function completeDailyDate(date: string): number | null {
    const parsed = dayjs(date, "YYYY.MM.DD", true);
    return parsed.isValid() ? parsed.valueOf() : null;
}

export function summarizeDailyStats(dailyStats: DailyStatsData[]) {
    let won = 0;
    let draw = 0;
    let lost = 0;

    for (const day of dailyStats) {
        won += day.won;
        draw += day.drawn;
        lost += day.lost;
    }

    return { total: won + draw + lost, won, draw, lost };
}
