import type { Page } from "@playwright/test";
import { serializeStorageValue } from "../src/state/store/debouncedStorage";
import type { RemoteEngine } from "../src/utils/engines";
import { expect, test } from "./fixtures";

const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const lines = [
    {
        uci: "e2e4",
        san: "e4",
        score: 24,
        rank: 2,
        note: "! (30-11)",
        winrate: "49.9",
        childFen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
        pv: ["e7e5", "g1f3", "b8c6"],
        pvSAN: ["e5", "Nf3", "Nc6"],
        depth: 30,
    },
    {
        uci: "d2d4",
        san: "d4",
        score: 18,
        rank: 2,
        note: "* (28-9)",
        winrate: "49.5",
        childFen: "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1",
        pv: ["d7d5", "c2c4", "e7e6"],
        pvSAN: ["d5", "c4", "e6"],
        depth: 28,
    },
    {
        uci: "g1f3",
        san: "Nf3",
        score: 12,
        rank: 1,
        note: "? (26-7)",
        winrate: "49.1",
        childFen: "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1",
        pv: ["g8f6", "c2c4", "e7e6"],
        pvSAN: ["Nf6", "c4", "e6"],
        depth: 26,
    },
];

async function openChessDBAnalysis(page: Page) {
    const engine: RemoteEngine = {
        type: "chessdb",
        id: "e2e-chessdb",
        name: "ChessDB",
        url: "https://www.chessdb.cn/",
        loaded: true,
        go: { t: "Infinite" },
        settings: [{ type: "string", name: "MultiPV", value: "3" }],
    };
    await page.addInitScript(
        (engines) => {
            localStorage.setItem("engines", engines);
            localStorage.setItem("letters", JSON.stringify("letters"));
        },
        serializeStorageValue([engine]),
    );
    await page.goto("/");
    await page.getByRole("button", { name: /^Analysis Board$/ }).click();
    await page.getByRole("tab", { name: "Analysis", exact: true }).click();
    const card = page.locator(".mantine-Accordion-item").filter({ hasText: "ChessDB" });
    await card.getByRole("button", { name: "Enable engine", exact: true }).click();
    await expect(card.getByRole("button", { name: "Disable engine", exact: true })).toBeVisible();
    return card;
}

for (const known of [true, false]) {
    test(`chessdb-engine: ${known ? "ranked full variations" : "unknown position is terminal and queued"}`, async ({
        page,
        mockScenario,
        capture,
    }) => {
        await mockScenario({ commands: {} });
        const requests: URL[] = [];
        // A fulfilled page route takes precedence over fixtures.ts's foreign-origin context block.
        // Assertions below require the real renderer fetches to reach this handler successfully.
        await page.route("https://www.chessdb.cn/**", async (route) => {
            const url = new URL(route.request().url());
            requests.push(url);
            const action = url.searchParams.get("action");
            let json: unknown;
            if (action === "queryall") {
                json = known
                    ? {
                          status: "ok",
                          moves: lines.map(({ uci, san, score, rank, note, winrate }) => ({
                              uci,
                              san,
                              score,
                              rank,
                              note,
                              winrate,
                          })),
                      }
                    : { status: "unknown" };
            } else if (action === "querypv") {
                const line = lines.find((line) => line.childFen === url.searchParams.get("board"));
                expect(line, "querypv must request a ranked move's child position").toBeDefined();
                json = {
                    status: "ok",
                    depth: line!.depth,
                    score: -line!.score,
                    pv: line!.pv,
                    pvSAN: line!.pvSAN,
                };
            } else {
                expect(action).toBe("queue");
                json = { status: "ok" };
            }
            await route.fulfill({ json });
        });
        const card = await openChessDBAnalysis(page);
        await expect
            .poll(
                () =>
                    requests.filter((url) => url.searchParams.get("action") === "queryall").length,
            )
            .toBe(1);
        expect(requests[0].searchParams.get("board")).toBe(startFen);
        await expect(card).not.toContainText(/nodes/i);
        await expect(card).not.toContainText("n/s");

        if (known) {
            const rows = card.getByRole("row").filter({
                has: page.getByRole("button", { name: "Expand analysis", exact: true }),
            });
            await expect(rows).toHaveCount(3);
            for (const [index, line] of lines.entries()) {
                const row = rows.nth(index);
                for (const move of [line.san, ...line.pvSAN]) {
                    await expect(
                        row.getByRole("button", { name: move, exact: true }),
                    ).toBeVisible();
                }
                await expect(row.getByText(line.note[0], { exact: true })).toBeVisible();
                const winrate = row.getByText(`${line.winrate}%`, { exact: true });
                await expect(winrate).toBeVisible();
                await winrate.hover();
                await expect(
                    page.getByRole("tooltip", { name: line.note, exact: true }),
                ).toBeVisible();
            }
            const pvs = requests.filter((url) => url.searchParams.get("action") === "querypv");
            expect(pvs).toHaveLength(3);
            expect(pvs.map((url) => url.searchParams.get("board")).sort()).toEqual(
                lines.map((line) => line.childFen).sort(),
            );
            for (const url of pvs) expect(url.searchParams.get("stable")).toBe("1");
            expect(requests.some((url) => url.searchParams.get("action") === "queue")).toBe(false);
        } else {
            await expect(
                card.getByText("This position is not in ChessDB yet.", { exact: true }),
            ).toBeVisible();
            await expect
                .poll(
                    () =>
                        requests.filter((url) => url.searchParams.get("action") === "queue").length,
                )
                .toBe(1);
            expect(
                requests
                    .find((url) => url.searchParams.get("action") === "queue")!
                    .searchParams.get("board"),
            ).toBe(startFen);
            expect(requests.some((url) => url.searchParams.get("action") === "querypv")).toBe(
                false,
            );
        }
        await expect(card.locator(".mantine-Skeleton-root, [data-animated]")).toHaveCount(0);
        await expect(card).not.toContainText("Loading");
        await page.mouse.move(0, 0);
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        const name = known ? "chessdb-known" : "chessdb-unknown";
        await capture(name);
        await expect(card).toHaveScreenshot(`${name}.png`);
    });
}
