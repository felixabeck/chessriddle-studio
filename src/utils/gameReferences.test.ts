import { expect, test, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { NormalizedGame, Player } from "@/bindings";
import Comment from "@/components/common/Comment";
import { GameReferenceProvider } from "@/components/common/GameReference";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { createTreeStore } from "@/state/store/tree";
import { EphemeralTabScope } from "@/state/tabScope";
import { getDatabases, query_games, query_players } from "./db";
import type { DatabaseList } from "./db";
import {
    lookupGameReference,
    matchesReferenceGame,
    matchesReferencePlayer,
    recognizeGameReferences,
    REFERENCE_SEARCH_LIMITS,
    type GameReference,
} from "./gameReferences";

vi.mock("./db", () => ({ getDatabases: vi.fn(), query_games: vi.fn(), query_players: vi.fn() }));
const admission = vi.hoisted(() => ({
    create: vi.fn(
        async (_args: Parameters<typeof import("@/utils/tabs").createTab>[0]) => "opened",
    ),
    navigate: vi.fn(),
}));
vi.mock("@/utils/tabs", async (original) => ({
    ...(await original<typeof import("@/utils/tabs")>()),
    createTab: admission.create,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => admission.navigate }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/files/notifyError", () => ({ notifyUnlessCancelled: vi.fn() }));
vi.mock("@mantine/core", async () => {
    const { createElement: element } = await import("react");
    type Props = { children?: ReactNode; title?: string; opened?: boolean };
    const container = ({ children }: Props) => element("div", null, children);
    return {
        Typography: container,
        Text: container,
        Stack: container,
        Paper: container,
        Loader: () => element("span", null, "Loading"),
        Alert: ({ title, children }: Props) => element("div", { role: "alert" }, title, children),
        Modal: ({ opened, children }: Props) =>
            opened ? element("div", { role: "dialog" }, children) : null,
        Button: ({ children, ...props }: React.ComponentProps<"button">) =>
            element("button", { onClick: props.onClick, disabled: props.disabled }, children),
    };
});

const beerdsen =
    "0-1 Beerdsen,T (2520)-Bluebaum,M (2651) Elllobregat op 3rd Sant Boi de Llobregat 2022 (3)";
const srinath =
    "0-1 Srinath,R (2255)-Deac,B (2690) Titled Tuesday intern op 19th Dec Late Chess.com INT blitz 2023 (6)";
const reference = recognizeGameReferences(beerdsen)[0];
const database = { id: { id: "source-a" }, kind: "database" as const };
const root = { id: { id: "root" }, kind: "databaseRoot" as const };
const game: NormalizedGame = {
    id: 1,
    fen: "start",
    white: "Beerdsen, Thomas",
    white_id: 11,
    white_elo: 2520,
    black: "Bluebaum, Matthias",
    black_id: 22,
    black_elo: 2651,
    event: "Elllobregat op 3rd",
    event_id: 1,
    site: "Sant Boi de Llobregat",
    site_id: 1,
    date: "2022.12.01",
    round: "3",
    result: "0-1",
    moves: "1. e4 c5 0-1",
};
function setup() {
    const library: DatabaseList = {
        root,
        unread: [],
        databases: [
            {
                type: "success",
                file: database,
                filename: "source-a.db3",
                title: "Source A",
                description: "",
                indexed: false,
                game_count: 1,
                player_count: 2,
                event_count: 1,
                storage_size: "4096",
            },
        ],
    };
    const api = {
        getDatabases: vi.fn(async () => library),
        query_players: vi.fn(async (_database, query) => ({
            data: [
                query.name === "Beerdsen"
                    ? { id: 11, name: game.white, game_count: 0, elo: 2520 }
                    : { id: 22, name: game.black, game_count: 0, elo: 2651 },
            ],
            count: 1,
        })),
        query_games: vi.fn(async () => ({ data: [game], count: 1 })),
    } as {
        getDatabases: ReturnType<typeof vi.fn<typeof import("./db").getDatabases>>;
        query_players: ReturnType<typeof vi.fn<typeof import("./db").query_players>>;
        query_games: ReturnType<typeof vi.fn<typeof import("./db").query_games>>;
    };
    return {
        library,
        api,
        search: (signal = new AbortController().signal) =>
            lookupGameReference(reference, signal, api),
    };
}

function querySensitiveSource(games: NormalizedGame[]) {
    const { api } = setup();
    api.query_games.mockImplementation(async (_database, query) => {
        const matching = games.filter(
            (candidate) =>
                (!query.startDate ||
                    (candidate.date != null && candidate.date >= query.startDate)) &&
                (!query.endDate || (candidate.date != null && candidate.date <= query.endDate)),
        );
        const pageSize = query.options?.pageSize ?? 100;
        const start = ((query.options?.page ?? 1) - 1) * pageSize;
        return { data: matching.slice(start, start + pageSize), count: matching.length };
    });
    return api;
}

// Drive the real lookup and provider. Admission is spied at its existing tab-creation boundary.
async function lookupUI(
    comment: string,
    api: ReturnType<typeof setup>["api"],
    inspect: (host: HTMLDivElement) => void | Promise<void>,
) {
    vi.mocked(getDatabases).mockImplementation(api.getDatabases);
    vi.mocked(query_players).mockImplementation(api.query_players);
    vi.mocked(query_games).mockImplementation(api.query_games);
    admission.create.mockClear();
    admission.navigate.mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const owner = createTreeStore();
    try {
        await act(async () =>
            root.render(
                createElement(
                    TreeStateContext.Provider,
                    { value: owner },
                    createElement(
                        EphemeralTabScope,
                        null,
                        createElement(
                            GameReferenceProvider,
                            null,
                            createElement(Comment, { comment }),
                        ),
                    ),
                ),
            ),
        );
        await act(async () =>
            host.querySelector<HTMLButtonElement>("[data-game-reference]")!.click(),
        );
        await inspect(host);
    } finally {
        await act(async () => root.unmount());
        owner.dispose();
        host.remove();
        vi.unstubAllGlobals();
    }
}

async function expectUnverifiedChoice(
    text: string,
    citation: GameReference,
    candidate: NormalizedGame,
) {
    const result = await lookupGameReference(
        citation,
        new AbortController().signal,
        querySensitiveSource([candidate]),
    );
    expect(result).toEqual({
        complete: true,
        failures: [],
        candidates: [
            {
                database,
                source: "Source A (source-a.db3)",
                game: candidate,
                verification: "unverified",
            },
        ],
    });
    await lookupUI(text, querySensitiveSource([candidate]), async (host) => {
        expect(admission.create).not.toHaveBeenCalled();
        expect(host.querySelector("[data-game-reference]")?.textContent).toBe(citation.label);
        expect(host.firstElementChild?.textContent).toBe(text);
        expect(host.textContent).toContain("Source A (source-a.db3)");
        expect(host.textContent).toContain("GameReferences.Choose");
        const open = [...host.querySelectorAll("button")].find(
            (node) => node.textContent === "Common.OpenGame",
        )!;
        await act(async () => open.click());
        expect(admission.create).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                headers: expect.objectContaining({
                    date: candidate.date,
                    round: candidate.round,
                    event: candidate.event,
                    site: candidate.site,
                }),
                gameOrigin: { kind: "database", database, gameId: candidate.id },
            }),
        );
    });
}

test.each(["????.??.??", "2023.01.01"])(
    "event year retains its candidate with actual Date %s through native date predicates",
    async (date) => {
        const citation = recognizeGameReferences(
            "0-1 Beerdsen,T (2520)-Bluebaum,M (2651) BEL-NED 2017 ICCF",
        )[0];
        const candidate = { ...game, event: "BEL-NED 2017", site: "ICCF", date };
        const api = querySensitiveSource([candidate]);
        const result = await lookupGameReference(citation, new AbortController().signal, api);
        expect(result.candidates.map((occurrence) => occurrence.game)).toEqual([candidate]);
        expect(matchesReferenceGame(citation, candidate)).toBe(true);
        expect(result).toMatchObject({
            complete: true,
            candidates: [{ verification: "verified" }],
        });
        expect(api.query_games.mock.calls[0][1].startDate).toBeUndefined();
        expect(api.query_games.mock.calls[0][1].endDate).toBeUndefined();
    },
);

test.each([
    { tail: "BEL-NED 2017 ICCF 2023 (3)", event: "BEL-NED 2017", site: "ICCF", date: "2023.01.01" },
    {
        tail: "Tournament 2024 City 2025 (3)",
        event: "Tournament 2024",
        site: "City",
        date: "2025.01.01",
    },
    {
        tail: "Tournament City 2024 2025 (3)",
        event: "Tournament",
        site: "City 2024",
        date: "2025.01.01",
    },
])(
    "candidate header boundaries resolve $tail before actual date and round",
    async ({ tail, ...headers }) => {
        const citation = recognizeGameReferences(
            `0-1 Beerdsen,T (2520)-Bluebaum,M (2651) ${tail}`,
        )[0];
        const candidate = { ...game, ...headers };
        const result = await lookupGameReference(
            citation,
            new AbortController().signal,
            querySensitiveSource([candidate]),
        );
        expect(matchesReferenceGame(citation, candidate)).toBe(true);
        expect(result).toMatchObject({
            complete: true,
            candidates: [{ game: candidate, verification: "verified" }],
        });
        for (const conflicting of [
            { date: "2021.01.01" },
            { round: "4" },
            { event: "Unrelated event" },
            { site: "Unrelated site" },
            { white_elo: 2519 },
            { black_elo: 2600 },
            { result: "1-0" as const },
            { white: "Beerdsen, Alice" },
        ]) {
            const conflict = { ...candidate, ...conflicting };
            expect(matchesReferenceGame(citation, conflict)).toBe(false);
            const rejected = await lookupGameReference(
                citation,
                new AbortController().signal,
                querySensitiveSource([conflict]),
            );
            expect(rejected.candidates).toEqual([]);
        }
    },
);

test("unverified remaining context preserves source completeness and requires a choice", async () => {
    const citation = recognizeGameReferences(
        "0-1 Beerdsen,T (2520)-Bluebaum,M (2651) Elllobregat op 3rd Sant Boi de Llobregat unclear context 2022 (3)",
    )[0];
    const result = await lookupGameReference(
        citation,
        new AbortController().signal,
        querySensitiveSource([game]),
    );
    expect(matchesReferenceGame(citation, game)).toBe(true);
    expect(result).toMatchObject({
        complete: true,
        failures: [],
        candidates: [{ game, verification: "unverified" }],
    });
    expect(matchesReferenceGame(citation, { ...game, date: "2021.01.01" })).toBe(false);
    expect(matchesReferenceGame(citation, { ...game, round: "4" })).toBe(false);
});

test.each([
    "White was better.",
    "Elllobregat op 3rd White was better.",
    "White was better before 2020.",
    "Elllobregat op 3rd White was better before 2020.",
    "Elllobregat op 3rd Sant Boi de Llobregat White was better before 2020.",
])(
    "open tail retains one unverified occurrence through query-sensitive lookup: %s",
    async (context) => {
        const label = "0-1 Beerdsen,T-Bluebaum,M";
        const citation = recognizeGameReferences(`${label} ${context}`)[0];
        const api = querySensitiveSource([game]);
        const result = await lookupGameReference(citation, new AbortController().signal, api);
        expect(citation).toMatchObject({ label, context });
        expect(result).toMatchObject({ complete: true, failures: [] });
        expect(result.candidates).toEqual([
            { database, source: "Source A (source-a.db3)", game, verification: "unverified" },
        ]);
        expect(api.query_games.mock.calls[0][1]).toMatchObject({
            player1: 11,
            player2: 22,
            sides: "WhiteBlack",
            outcome: "0-1",
        });
        expect(api.query_games.mock.calls[0][1].startDate).toBeUndefined();
        expect(api.query_games.mock.calls[0][1].endDate).toBeUndefined();
        for (const conflict of [
            { white: "Beerdsen, Alice" },
            { black: "Beerdsen, Thomas" },
            { result: "1-0" as const },
        ])
            expect(matchesReferenceGame(citation, { ...game, ...conflict })).toBe(false);
    },
);

test.each([
    "Elllobregat op 3rd Sant Boi de Llobregat",
    "Elllobregat op 3rd Sant Boi de Llobregat 2022",
])("actual event/site context without a closing round verifies: %s", async (context) => {
    const citation = recognizeGameReferences(`0-1 Beerdsen,T-Bluebaum,M ${context}`)[0];
    const result = await lookupGameReference(
        citation,
        new AbortController().signal,
        querySensitiveSource([game]),
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].verification).toBe("verified");
});

test.each(["Elllobregat op 3rd 2021", "Elllobregat op 3rd Sant Boi de Llobregat (4)"])(
    "identifiable date and round contradictions still reject: %s",
    async (context) => {
        const citation = recognizeGameReferences(`0-1 Beerdsen,T-Bluebaum,M ${context}`)[0];
        const result = await lookupGameReference(
            citation,
            new AbortController().signal,
            querySensitiveSource([game]),
        );
        expect(result.candidates).toEqual([]);
    },
);

test("an unrelated site after a numeral cannot be offered as unverified context", async () => {
    const citation = recognizeGameReferences("0-1 Beerdsen,T-Bluebaum,M BEL-NED 2017 ICCF")[0];
    const candidate = { ...game, event: "BEL-NED", site: "Unrelated site", date: "2017.01.01" };
    expect(matchesReferenceGame(citation, candidate)).toBe(false);
    expect(
        (
            await lookupGameReference(
                citation,
                new AbortController().signal,
                querySensitiveSource([candidate]),
            )
        ).candidates,
    ).toEqual([]);
});

test.each([{ date: "????.??.??" }, { round: "?" }])(
    "missing actual metadata retains only an unverified occurrence: %j",
    async (missing) => {
        const candidate = { ...game, ...missing };
        const result = await lookupGameReference(
            reference,
            new AbortController().signal,
            querySensitiveSource([candidate]),
        );
        expect(result).toMatchObject({
            complete: true,
            candidates: [{ verification: "unverified" }],
        });
    },
);

test("both screenshot citations retain hard constraints and verified lookup", async () => {
    const second = {
        ...game,
        white: "Srinath, Rao",
        black: "Deac, Bogdan",
        white_elo: 2255,
        black_elo: 2690,
        event: "Titled Tuesday intern op 19th Dec Late",
        site: "Chess.com INT blitz",
        date: "2023.12.19",
        round: "6",
    };
    for (const [label, candidate] of [
        [beerdsen, game],
        [srinath, second],
    ] as const) {
        const citation = recognizeGameReferences(label)[0];
        const api = querySensitiveSource([candidate]);
        api.query_players.mockResolvedValue({
            data: [
                { id: 11, name: candidate.white, game_count: 0, elo: candidate.white_elo! },
                { id: 22, name: candidate.black, game_count: 0, elo: candidate.black_elo! },
            ],
            count: 2,
        });
        const result = await lookupGameReference(citation, new AbortController().signal, api);
        expect(result).toMatchObject({
            complete: true,
            candidates: [{ game: candidate, verification: "verified" }],
        });
        for (const conflict of [
            { white_elo: 0 },
            { black_elo: 0 },
            { white: "Srinath, Alice" },
            { result: "1-0" as const },
        ])
            expect(matchesReferenceGame(citation, { ...candidate, ...conflict })).toBe(false);
    }
});

test.each([
    { event: "Tata Steel (A)", site: "Wijk aan Zee", round: "3" },
    { event: "Open (2)", site: "Hall (1)", round: "A" },
])("parenthesized $event and $site retain the final round $round", async (headers) => {
    const label = `0-1 Beerdsen,T-Bluebaum,M ${headers.event} ${headers.site} 2022 (${headers.round})`;
    const text = `Before ${label} Ordinary following prose. ${srinath} More prose.`;
    const citations = recognizeGameReferences(text);
    expect(citations.map((citation) => citation.label)).toEqual([label, srinath]);
    for (const citation of citations)
        expect(text.slice(citation.start, citation.end)).toBe(citation.label);
    const candidate = { ...game, ...headers };
    const result = await lookupGameReference(
        citations[0],
        new AbortController().signal,
        querySensitiveSource([candidate]),
    );
    expect(result).toMatchObject({ complete: true, candidates: [{ verification: "verified" }] });
    for (const conflict of [
        { date: "2021.01.01" },
        { round: "9" },
        { event: "Other event" },
        { site: "Other site" },
    ]) {
        const conflicting = { ...candidate, ...conflict };
        const rejected = await lookupGameReference(
            citations[0],
            new AbortController().signal,
            querySensitiveSource([conflicting]),
        );
        expect(rejected.candidates).toEqual([]);
        await lookupUI(label, querySensitiveSource([conflicting]), () => {
            expect(admission.create).not.toHaveBeenCalled();
        });
    }
    const rich = `Before **0-1 Beerdsen,T**-Bluebaum,M **${headers.event}** *${headers.site}* 2022 (${headers.round}) Ordinary following prose. ${srinath} More prose.`;
    await lookupUI(rich, querySensitiveSource([candidate]), (host) => {
        expect(
            [...host.querySelectorAll("[data-game-reference]")].map((node) => node.textContent),
        ).toEqual([label, srinath]);
        expect(host.querySelector("[data-game-reference] strong")?.textContent).toBe(
            "0-1 Beerdsen,T",
        );
        expect(host.firstElementChild?.textContent).toBe(text);
        expect(admission.create).toHaveBeenCalledTimes(1);
    });
});

test("an ambiguous parenthesized boundary retains all context and requires selection", async () => {
    const label = "0-1 Beerdsen,T-Bluebaum,M";
    const context = "Tata Steel (A) Wijk aan Zee";
    const candidate = { ...game, event: "Tata Steel (A)", site: "Wijk aan Zee" };
    const citation = recognizeGameReferences(`${label} ${context}`)[0];
    expect(citation).toMatchObject({ label, context, closed: false });
    const result = await lookupGameReference(
        citation,
        new AbortController().signal,
        querySensitiveSource([candidate]),
    );
    expect(result).toMatchObject({ complete: true, candidates: [{ verification: "unverified" }] });
    await lookupUI(`${label} ${context}`, querySensitiveSource([candidate]), async (host) => {
        expect(admission.create).not.toHaveBeenCalled();
        expect(host.textContent).toContain("GameReferences.Choose");
        const open = [...host.querySelectorAll("button")].find(
            (node) => node.textContent === "Common.OpenGame",
        )!;
        await act(async () => open.click());
        expect(admission.create).toHaveBeenCalledTimes(1);
    });
});

test("parenthesized event cannot authorize automatic admission across later contradictions", async () => {
    const label = "0-1 Beerdsen,T-Bluebaum,M Tata Steel (A) Wijk aan Zee 2022 (3)";
    const candidate = {
        ...game,
        event: "Tata Steel (A)",
        site: "Wijk aan Zee",
        date: "2021.01.01",
        round: "9",
    };
    await lookupUI(label, querySensitiveSource([candidate]), () => {
        expect(admission.create).not.toHaveBeenCalled();
    });
    const result = await lookupGameReference(
        recognizeGameReferences(label)[0],
        new AbortController().signal,
        querySensitiveSource([candidate]),
    );
    expect(result.candidates).toEqual([]);
});

test.each(["Better was Bd3 (A).", "Better was Bd3 (1).", "Better was Bd3 in 2020."])(
    "an established closing round separates matching metadata from ordinary prose: %s",
    async (prose) => {
        const label = "0-1 Beerdsen,T-Bluebaum,M Tata Steel (A) Wijk aan Zee 2022 (3)";
        const candidate = { ...game, event: "Tata Steel (A)", site: "Wijk aan Zee" };
        const text = `Before ${label} ${prose} ${srinath} Next prose.`;
        const [citation, next] = recognizeGameReferences(text);
        const result = await lookupGameReference(
            citation,
            new AbortController().signal,
            querySensitiveSource([candidate]),
        );
        expect(result).toEqual({
            complete: true,
            failures: [],
            candidates: [
                {
                    database,
                    source: "Source A (source-a.db3)",
                    game: candidate,
                    verification: "verified",
                },
            ],
        });
        expect(citation).toMatchObject({
            label,
            context: `Tata Steel (A) Wijk aan Zee 2022 (3) ${prose}`,
        });
        expect(text.slice(citation.start, citation.end)).toBe(label);
        expect(next.label).toBe(srinath);
        const rich = `Before ${label.replace("Beerdsen,T", "**Beerdsen,T**").replace("Wijk aan Zee", "*Wijk aan Zee*")} ${prose} ${srinath} Next prose.`;
        await lookupUI(rich, querySensitiveSource([candidate]), (host) => {
            expect(admission.create).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    headers: expect.objectContaining({
                        event: candidate.event,
                        site: candidate.site,
                        date: candidate.date,
                        round: candidate.round,
                    }),
                    gameOrigin: { kind: "database", database, gameId: candidate.id },
                }),
            );
            expect(
                [...host.querySelectorAll("[data-game-reference]")].map((node) => node.textContent),
            ).toEqual([label, srinath]);
            expect(host.querySelector("[data-game-reference] strong")?.textContent).toBe(
                "Beerdsen,T",
            );
            expect(host.querySelector("[data-game-reference] em")?.textContent).toBe(
                "Wijk aan Zee",
            );
            expect(host.firstElementChild?.textContent).toBe(text);
        });
        for (const conflict of [{ date: "2021.12.01" }, { round: "9" }]) {
            const rejected = await lookupGameReference(
                citation,
                new AbortController().signal,
                querySensitiveSource([{ ...candidate, ...conflict }]),
            );
            expect(rejected.candidates).toEqual([]);
            await lookupUI(rich, querySensitiveSource([{ ...candidate, ...conflict }]), () => {
                expect(admission.create).not.toHaveBeenCalled();
            });
        }
    },
);

test.each([
    { event: "Festival 2020 (A)", site: "Hall" },
    { event: "Festival", site: "Hall 2021 (2)" },
    { event: "Festival 2020 (A)", site: "Hall 2021 (2)" },
])(
    "candidate headers containing year-round text resolve before fields: $event / $site",
    async (headers) => {
        const pair = "0-1 Beerdsen,T-Bluebaum,M";
        const context = `${headers.event} ${headers.site} 2022 (3) Better was Bd3 (A) in 2024.`;
        const text = `${pair} ${context}`;
        const citation = recognizeGameReferences(text)[0];
        const candidate = { ...game, ...headers };
        const result = await lookupGameReference(
            citation,
            new AbortController().signal,
            querySensitiveSource([candidate]),
        );
        expect(result).toMatchObject({
            complete: true,
            failures: [],
            candidates: [{ game: candidate, verification: "verified" }],
        });
        expect(citation).toMatchObject({ label: pair, context, closed: false });
        expect(text.slice(citation.start, citation.end)).toBe(pair);
        await lookupUI(text, querySensitiveSource([candidate]), (host) => {
            expect(host.querySelector("[data-game-reference]")?.textContent).toBe(pair);
            expect(host.firstElementChild?.textContent).toBe(text);
            expect(admission.create).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    headers: expect.objectContaining(headers),
                    gameOrigin: { kind: "database", database, gameId: candidate.id },
                }),
            );
        });
        for (const conflict of [{ date: "2021.01.01" }, { round: "9" }]) {
            const rejected = await lookupGameReference(
                citation,
                new AbortController().signal,
                querySensitiveSource([{ ...candidate, ...conflict }]),
            );
            expect(rejected.candidates).toEqual([]);
        }
    },
);

test.each([
    {
        kind: "event-only parenthesis",
        context: "Tata Steel (A) Wijk aan Zee 2022 (3)",
        short: { event: "Tata Steel", site: "Wijk aan Zee" },
        full: { event: "Tata Steel (A)", site: "Wijk aan Zee" },
        earlyDate: "2021.01.01",
        retained: [false, false, false],
    },
    {
        kind: "event-only year-round",
        context: "Tata Steel 2020 (A) Wijk aan Zee 2022 (3)",
        short: { event: "Tata Steel", site: "Wijk aan Zee" },
        full: { event: "Tata Steel 2020 (A)", site: "Wijk aan Zee" },
        earlyDate: "2020.01.01",
        retained: [false, false, false],
    },
    {
        kind: "site-only parenthesis",
        context: "Wijk aan Zee (A) 2022 (3)",
        short: { event: "Unspecified event", site: "Wijk aan Zee" },
        full: { event: "Unspecified event", site: "Wijk aan Zee (A)" },
        earlyDate: "2021.01.01",
        retained: [true, true, false],
    },
    {
        kind: "site-only year-round",
        context: "Wijk aan Zee 2020 (A) 2022 (3)",
        short: { event: "Unspecified event", site: "Wijk aan Zee" },
        full: { event: "Unspecified event", site: "Wijk aan Zee 2020 (A)" },
        earlyDate: "2020.01.01",
        retained: [true, false, false],
    },
    {
        kind: "combined parenthesis",
        context: "Tata Steel Wijk aan Zee (A) 2022 (3)",
        short: { event: "Tata Steel", site: "Wijk aan Zee" },
        full: { event: "Tata Steel", site: "Wijk aan Zee (A)" },
        earlyDate: "2021.01.01",
        retained: [true, true, false],
    },
    {
        kind: "combined year-round",
        context: "Tata Steel Wijk aan Zee 2020 (A) 2022 (3)",
        short: { event: "Tata Steel", site: "Wijk aan Zee" },
        full: { event: "Tata Steel", site: "Wijk aan Zee 2020 (A)" },
        earlyDate: "2020.01.01",
        retained: [true, false, false],
    },
])(
    "complete header confidence handles a shorter $kind boundary before later constraints",
    async ({ context, short, full, earlyDate, retained }) => {
        const label = `0-1 Beerdsen,T-Bluebaum,M ${context}`;
        const citation = recognizeGameReferences(label)[0];
        for (const [index, metadata] of [
            { date: earlyDate, round: "A" },
            { date: "2022.12.01", round: "A" },
            { date: "2021.01.01", round: "3" },
        ].entries()) {
            const candidate = { ...game, ...short, ...metadata };
            const result = await lookupGameReference(
                citation,
                new AbortController().signal,
                querySensitiveSource([candidate]),
            );
            expect(result).toEqual({
                candidates: retained[index]
                    ? [
                          {
                              database,
                              source: "Source A (source-a.db3)",
                              game: candidate,
                              verification: "unverified",
                          },
                      ]
                    : [],
                failures: [],
                complete: true,
            });
            await lookupUI(label, querySensitiveSource([candidate]), async (host) => {
                expect(admission.create).not.toHaveBeenCalled();
                const open = [...host.querySelectorAll("button")].find(
                    (node) => node.textContent === "Common.OpenGame",
                );
                await act(async () => open?.click());
                expect(admission.create).toHaveBeenCalledTimes(retained[index] ? 1 : 0);
                expect(admission.create.mock.calls.map(([args]) => args.gameOrigin)).toEqual(
                    retained[index] ? [{ kind: "database", database, gameId: candidate.id }] : [],
                );
            });
        }
        const unresolved = { ...game, ...short };
        const offered = await lookupGameReference(
            citation,
            new AbortController().signal,
            querySensitiveSource([unresolved]),
        );
        expect(offered).toMatchObject({
            complete: true,
            candidates: [{ game: unresolved, verification: "unverified" }],
        });
        await lookupUI(label, querySensitiveSource([unresolved]), async (host) => {
            expect(admission.create).not.toHaveBeenCalled();
            expect(host.textContent).toContain("GameReferences.Choose");
            const open = [...host.querySelectorAll("button")].find(
                (node) => node.textContent === "Common.OpenGame",
            )!;
            await act(async () => open.click());
            expect(admission.create).toHaveBeenCalledTimes(1);
        });
        const counterpart = { ...game, ...full };
        const verified = await lookupGameReference(
            citation,
            new AbortController().signal,
            querySensitiveSource([counterpart]),
        );
        expect(verified).toMatchObject({
            complete: true,
            candidates: [{ game: counterpart, verification: "verified" }],
        });
        await lookupUI(label, querySensitiveSource([counterpart]), () => {
            expect(admission.create).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    headers: expect.objectContaining({
                        ...full,
                        date: counterpart.date,
                        round: counterpart.round,
                    }),
                    gameOrigin: { kind: "database", database, gameId: counterpart.id },
                }),
            );
        });
    },
);

test("a shorter event prefix cannot authorize automatic admission", async () => {
    const label = "0-1 Beerdsen,T-Bluebaum,M Tata Steel (A) Wijk aan Zee 2022 (3)";
    const candidate = {
        ...game,
        event: "Tata Steel",
        site: "Wijk aan Zee",
        date: "2021.01.01",
        round: "A",
    };
    await lookupUI(label, querySensitiveSource([candidate]), () => {
        expect(admission.create).not.toHaveBeenCalled();
    });
});

test.each(["(A)", "2020 (A)"])(
    "competing unresolved header extensions require explicit choice: %s",
    async (extension) => {
        const label = `0-1 Beerdsen,T-Bluebaum,M Hall ${extension} Annex 2022 (3)`;
        const candidate = {
            ...game,
            event: "Unspecified event",
            site: "Hall",
            date: "2021.01.01",
            round: "A",
        };
        const result = await lookupGameReference(
            recognizeGameReferences(label)[0],
            new AbortController().signal,
            querySensitiveSource([candidate]),
        );
        expect(result).toMatchObject({
            complete: true,
            candidates: [{ game: candidate, verification: "unverified" }],
        });
        await lookupUI(label, querySensitiveSource([candidate]), (host) => {
            expect(admission.create).not.toHaveBeenCalled();
            expect(host.textContent).toContain("GameReferences.Choose");
        });
        const counterpart = { ...game, event: candidate.event, site: `Hall ${extension} Annex` };
        await lookupUI(label, querySensitiveSource([counterpart]), () => {
            expect(admission.create).toHaveBeenCalledTimes(1);
        });
    },
);

test.each(["Wijk aan Zee", "?", ""])(
    "genuine round-only metadata retains verified admission with site %j",
    async (site) => {
        const label = "0-1 Beerdsen,T-Bluebaum,M Tata Steel (3) Better was Bd3 (A) in 2020.";
        const candidate = { ...game, event: "Tata Steel", site };
        const result = await lookupGameReference(
            recognizeGameReferences(label)[0],
            new AbortController().signal,
            querySensitiveSource([candidate]),
        );
        expect(result).toMatchObject({
            complete: true,
            candidates: [{ game: candidate, verification: "verified" }],
        });
        await lookupUI(label, querySensitiveSource([candidate]), () => {
            expect(admission.create).toHaveBeenCalledTimes(1);
        });
    },
);

test.each(["2024: Better was Bd3.", "2024 improvements included Bd3."])(
    "year-led prose retains original metadata for explicit selection: %s",
    async (prose) => {
        const label = "0-1 Beerdsen,T-Bluebaum,M Tata Steel (A) Wijk aan Zee 2022 (3)";
        const text = `${label} ${prose}`;
        const candidate = { ...game, event: "Tata Steel (A)", site: "Wijk aan Zee" };
        const citation = recognizeGameReferences(text)[0];
        const result = await lookupGameReference(
            citation,
            new AbortController().signal,
            querySensitiveSource([candidate]),
        );
        expect(result).toEqual({
            complete: true,
            failures: [],
            candidates: [
                {
                    database,
                    source: "Source A (source-a.db3)",
                    game: candidate,
                    verification: "unverified",
                },
            ],
        });
        expect(citation).toMatchObject({
            label,
            context: `Tata Steel (A) Wijk aan Zee 2022 (3) ${prose}`,
        });
        await lookupUI(text, querySensitiveSource([candidate]), async (host) => {
            expect(admission.create).not.toHaveBeenCalled();
            expect(host.querySelector("[data-game-reference]")?.textContent).toBe(label);
            expect(host.textContent).toContain("GameReferences.Choose");
            expect(host.textContent).toContain("Source A (source-a.db3)");
            const open = [...host.querySelectorAll("button")].find(
                (node) => node.textContent === "Common.OpenGame",
            )!;
            await act(async () => open.click());
            expect(admission.create).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    headers: expect.objectContaining({
                        date: "2022.12.01",
                        round: "3",
                        event: candidate.event,
                        site: candidate.site,
                    }),
                    gameOrigin: { kind: "database", database, gameId: candidate.id },
                }),
            );
        });
        for (const conflict of [{ date: "2021.01.01" }, { date: "2024.01.01" }, { round: "9" }]) {
            const conflicting = { ...candidate, ...conflict };
            const rejected = await lookupGameReference(
                citation,
                new AbortController().signal,
                querySensitiveSource([conflicting]),
            );
            expect(rejected.candidates).toEqual([]);
            await lookupUI(text, querySensitiveSource([conflicting]), () => {
                expect(admission.create).not.toHaveBeenCalled();
            });
        }
    },
);

test("the known site establishes a later year even without another round", async () => {
    const label = "0-1 Beerdsen,T-Bluebaum,M Tata Steel (A) Wijk aan Zee 2022";
    const citation = recognizeGameReferences(label)[0];
    const candidate = {
        ...game,
        event: "Tata Steel",
        site: "Wijk aan Zee",
        date: "2021.01.01",
        round: "A",
    };
    const rejected = await lookupGameReference(
        citation,
        new AbortController().signal,
        querySensitiveSource([candidate]),
    );
    expect(rejected).toEqual({ candidates: [], failures: [], complete: true });
    await lookupUI(label, querySensitiveSource([candidate]), () => {
        expect(admission.create).not.toHaveBeenCalled();
    });
    const uncertain = { ...candidate, date: "2022.12.01" };
    const offered = await lookupGameReference(
        citation,
        new AbortController().signal,
        querySensitiveSource([uncertain]),
    );
    expect(offered).toMatchObject({
        complete: true,
        candidates: [{ game: uncertain, verification: "unverified" }],
    });
    const counterpart = { ...uncertain, event: "Tata Steel (A)", round: "3" };
    const verified = await lookupGameReference(
        citation,
        new AbortController().signal,
        querySensitiveSource([counterpart]),
    );
    expect(verified).toMatchObject({
        complete: true,
        candidates: [{ game: counterpart, verification: "verified" }],
    });
    await lookupUI(label, querySensitiveSource([counterpart]), () => {
        expect(admission.create).toHaveBeenCalledTimes(1);
    });
});

test.each([
    { prose: "2024 (A): Better was Bd3.", laterRound: "A" },
    { prose: "2024 (1) was a different tournament.", laterRound: "1" },
])("viable competing readings require a choice for $prose", async ({ prose, laterRound }) => {
    const pair = "0-1 Beerdsen,T-Bluebaum,M";
    const text = `${pair} Tata Steel (A) Wijk aan Zee 2022 (3) ${prose}`;
    const citation = recognizeGameReferences(text)[0];
    const original = { ...game, event: "Tata Steel (A)", site: "Wijk aan Zee" };
    expect(citation.label).toBe(pair);
    await expectUnverifiedChoice(text, citation, original);
    await expectUnverifiedChoice(text, citation, {
        ...original,
        date: "2024.01.01",
        round: laterRound,
    });
    for (const missing of [
        { date: "????.??.??" },
        { round: "?" },
        { date: "????.??.??", round: "?" },
    ])
        await expectUnverifiedChoice(text, citation, { ...original, ...missing });
    for (const conflict of [
        { date: "2023.01.01", round: "9" },
        { date: "2022.12.01", round: laterRound },
        { date: "2024.01.01", round: "3" },
        { date: "2023.01.01", round: "?" },
    ]) {
        const candidate = { ...original, ...conflict };
        const rejected = await lookupGameReference(
            citation,
            new AbortController().signal,
            querySensitiveSource([candidate]),
        );
        expect(rejected).toEqual({ candidates: [], failures: [], complete: true });
        await lookupUI(text, querySensitiveSource([candidate]), () => {
            expect(admission.create).not.toHaveBeenCalled();
        });
    }
});

test.each([
    { prose: "Better was Bd3 in 2024 (A).", laterRound: "A" },
    { prose: "Better was Bd3 2024 (A).", laterRound: "A" },
])(
    "intervening prose keeps the anchored year and round as an explicit choice for $prose",
    async ({ prose, laterRound }) => {
        const pair = "0-1 Beerdsen,T-Bluebaum,M";
        const text = `${pair} Tata Steel (A) Wijk aan Zee 2022 (3) ${prose}`;
        const citation = recognizeGameReferences(text)[0];
        const original = { ...game, event: "Tata Steel (A)", site: "Wijk aan Zee" };
        expect(citation).toMatchObject({
            label: pair,
            context: `Tata Steel (A) Wijk aan Zee 2022 (3) ${prose}`,
            closed: false,
        });
        expect(text.slice(citation.start, citation.end)).toBe(pair);
        await expectUnverifiedChoice(text, citation, original);
        for (const missing of [
            { date: "????.??.??" },
            { round: "?" },
            { date: "????.??.??", round: "?" },
        ])
            await expectUnverifiedChoice(text, citation, { ...original, ...missing });
        for (const conflict of [
            { date: "2021.01.01", round: "9" },
            { date: "2024.01.01", round: laterRound },
            { date: "2021.01.01" },
            { round: "9" },
            { date: "2024.01.01" },
            { round: laterRound },
        ]) {
            const candidate = { ...original, ...conflict };
            const rejected = await lookupGameReference(
                citation,
                new AbortController().signal,
                querySensitiveSource([candidate]),
            );
            expect(rejected).toEqual({ candidates: [], failures: [], complete: true });
            await lookupUI(text, querySensitiveSource([candidate]), () => {
                expect(admission.create).not.toHaveBeenCalled();
            });
        }
    },
);

test.each([
    {
        kind: "dated-round",
        context: "Tata Steel Wijk aan Zee 2020 (A) Better was Bd3 2022 (3).",
        controlContext: "Tata Steel Wijk aan Zee 2020 (A) Better was Bd3.",
        short: { event: "Tata Steel", site: "Wijk aan Zee", date: "2020.01.01", round: "A" },
        conflicts: [
            { date: "2021.01.01", round: "9" },
            { date: "2022.12.01", round: "3" },
            { date: "2021.01.01" },
            { round: "9" },
            { date: "2022.12.01" },
            { round: "3" },
        ],
    },
    {
        kind: "round-only",
        context: "Tata Steel Wijk aan Zee (A) Better was Bd3 2022 (3).",
        controlContext: "Tata Steel Wijk aan Zee (A) Better was Bd3.",
        short: { event: "Tata Steel", site: "Wijk aan Zee", date: "2021.01.01", round: "A" },
        conflicts: [{ date: "2022.12.01", round: "3" }, { round: "3" }, { round: "9" }],
    },
])(
    "a matching combined $kind prefix cannot close once a later complete tuple remains",
    async ({ context, controlContext, short, conflicts }) => {
        const pair = "0-1 Beerdsen,T-Bluebaum,M";
        const text = `${pair} ${context}`;
        const citation = recognizeGameReferences(text)[0];
        const original = { ...game, ...short };
        expect(citation).toMatchObject({ context });
        expect(text.slice(citation.start, citation.end)).toBe(citation.label);
        await expectUnverifiedChoice(text, citation, original);
        for (const missing of [
            { date: "????.??.??" },
            { round: "?" },
            { date: "????.??.??", round: "?" },
        ])
            await expectUnverifiedChoice(text, citation, { ...original, ...missing });
        for (const conflict of conflicts) {
            const candidate = { ...original, ...conflict };
            const rejected = await lookupGameReference(
                citation,
                new AbortController().signal,
                querySensitiveSource([candidate]),
            );
            expect(rejected).toEqual({ candidates: [], failures: [], complete: true });
            await lookupUI(text, querySensitiveSource([candidate]), () => {
                expect(admission.create).not.toHaveBeenCalled();
            });
        }
        const controlText = `${pair} ${controlContext}`;
        const controlCitation = recognizeGameReferences(controlText)[0];
        const control = await lookupGameReference(
            controlCitation,
            new AbortController().signal,
            querySensitiveSource([original]),
        );
        expect(control).toEqual({
            complete: true,
            failures: [],
            candidates: [
                {
                    database,
                    source: "Source A (source-a.db3)",
                    game: original,
                    verification: "verified",
                },
            ],
        });
        await lookupUI(controlText, querySensitiveSource([original]), (host) => {
            expect(host.querySelector("[data-game-reference]")?.textContent).toBe(
                controlCitation.label,
            );
            expect(admission.create).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    headers: expect.objectContaining({
                        date: original.date,
                        round: original.round,
                        event: original.event,
                        site: original.site,
                    }),
                    gameOrigin: { kind: "database", database, gameId: original.id },
                }),
            );
        });
    },
);

test.each(["Smith, JOHN", "Smith, John", "Smith, john", "JOHN Smith", "John Smith", "john Smith"])(
    "JO rejects a full single given name consistently through lookup: %s",
    async (name) => {
        const { api } = setup();
        api.query_players.mockImplementation(async (_database, query) => ({
            data:
                query.name === "Smith"
                    ? [{ id: 11, name, game_count: 0, elo: null }]
                    : [{ id: 22, name: game.black, game_count: 0, elo: null }],
            count: 1,
        }));
        api.query_games.mockResolvedValue({ data: [{ ...game, white: name }], count: 1 });
        const citation = recognizeGameReferences("0-1 Smith,JO-Bluebaum,M")[0];
        const result = await lookupGameReference(citation, new AbortController().signal, api);
        expect(result).toEqual({ complete: true, failures: [], candidates: [] });
        expect(api.query_games).not.toHaveBeenCalled();
        expect(matchesReferenceGame(citation, { ...game, white: name })).toBe(false);
    },
);

test.each([
    ["Smith, JK", "unverified"],
    ["Smith, Jk", "unverified"],
    ["Smith, jk", "unverified"],
    ["JK Smith", "unverified"],
    ["Jk Smith", "unverified"],
    ["jk Smith", "unverified"],
    ["Smith, J K", "verified"],
    ["Smith, j k", "verified"],
    ["J K Smith", "verified"],
    ["j k Smith", "verified"],
    ["Smith, J.K.", "verified"],
    ["Smith, j.k.", "verified"],
    ["J.K. Smith", "verified"],
    ["j.k. Smith", "verified"],
    ["Smith, Jan Karl", "verified"],
    ["Smith, JAN KARL", "verified"],
    ["Smith, jan karl", "verified"],
    ["Jan Karl Smith", "verified"],
    ["JAN KARL Smith", "verified"],
    ["jan karl Smith", "verified"],
] as const)(
    "JK retains %s with %s identity through discovery and verification",
    async (name, verification) => {
        const candidate = { ...game, white: name };
        const api = querySensitiveSource([candidate]);
        api.query_players.mockImplementation(async (_database, query) => ({
            data:
                query.name === "Smith"
                    ? [{ id: 11, name, game_count: 0, elo: null }]
                    : [{ id: 22, name: game.black, game_count: 0, elo: null }],
            count: 1,
        }));
        const label = "0-1 Smith,JK-Bluebaum,M";
        const citation = recognizeGameReferences(label)[0];
        const result = await lookupGameReference(citation, new AbortController().signal, api);
        expect(result).toMatchObject({
            complete: true,
            failures: [],
            candidates: [{ game: candidate, verification }],
        });
        expect(api.query_games).toHaveBeenCalledExactlyOnceWith(
            database,
            expect.objectContaining({
                player1: 11,
                player2: 22,
                sides: "WhiteBlack",
                outcome: "0-1",
            }),
            expect.anything(),
        );
        expect(matchesReferencePlayer(citation.white, name)).toBe(true);
        await lookupUI(label, api, (host) => {
            expect(admission.create).toHaveBeenCalledTimes(verification === "verified" ? 1 : 0);
            expect(host.textContent).toContain("GameReferences.Choose");
        });
    },
);

test("recognizes the two exact screenshot citations without surrounding prose", () => {
    const text = `Before ${beerdsen} This is ordinary prose. ${srinath} More prose.`;
    const found = recognizeGameReferences(text);
    expect(found.map((entry) => entry.label)).toEqual([beerdsen, srinath]);
    expect(found[0]).toMatchObject({
        outcome: "0-1",
        white: { surname: "Beerdsen", initials: "T", rating: 2520 },
        black: { surname: "Bluebaum", initials: "M", rating: 2651 },
        context: "Elllobregat op 3rd Sant Boi de Llobregat 2022 (3) This is ordinary prose.",
        closed: true,
    });
    expect(found[1]).toMatchObject({
        context: "Titled Tuesday intern op 19th Dec Late Chess.com INT blitz 2023 (6) More prose.",
        closed: true,
    });
    for (const foundReference of found)
        expect(text.slice(foundReference.start, foundReference.end)).toBe(foundReference.label);
});

test("keeps an unterminated tail for verification without extending the visible label", () => {
    const label = "0-1 Beerdsen,T (2520)-Bluebaum,M (2651)";
    const context = "BEL-NED 2017 ICCF and this is ordinary preparation prose.";
    const text = `${label} ${context}`;
    const [citation] = recognizeGameReferences(text);

    expect(citation).toMatchObject({ label, context });
    expect(text.slice(citation.start, citation.end)).toBe(label);
});

test("recognizes Unicode, hyphens, apostrophes, optional ratings and missing metadata", () => {
    const found = recognizeGameReferences(
        "½-½ Duda-Krüger,J.K.-O’Kelly,A ICCF Europe (2.1) then 1-0 Šarić,I-Deac,B",
    );
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
        white: { surname: "Duda-Krüger", initials: "J.K." },
        black: { surname: "O’Kelly", initials: "A" },
        context: "ICCF Europe (2.1) then",
        closed: false,
    });
    expect(found[1]).toMatchObject({ context: "", label: "1-0 Šarić,I-Deac,B" });
    expect(recognizeGameReferences("0-1 some ordinary prose and 1-0 Smithson-Black")).toEqual([]);
});

test.each([
    ["Beerdsen, Thomas", true],
    ["Thomas Beerdsen", true],
    ["Beerdsen,T", true],
    ["Beerdsen, Tim", true],
    ["Beerdsen, A T", false],
    ["Van Beerdsen, Thomas", false],
    ["Thomas Beerdsen Jr", false],
    ["Beerdsenberg, Thomas", false],
    ["Tomas Beerd", false],
])("surname identity and given initial constrain %s", (name, expected) => {
    expect(matchesReferencePlayer(reference.white, name)).toBe(expected);
});

test("normalizes Unicode and distinguishes surname letters from initials", () => {
    expect(
        matchesReferencePlayer({ surname: "Šarić", initials: "I" }, "S\u030caric\u0301, Ivan"),
    ).toBe(true);
    expect(matchesReferencePlayer({ surname: "Smith", initials: "M" }, "Smith, Alice")).toBe(false);
    expect(
        matchesReferencePlayer({ surname: "Duda-Krüger", initials: "JK" }, "Duda-Krüger, Jan-Karl"),
    ).toBe(true);
});

test("every supplied field constrains candidates", () => {
    expect(matchesReferenceGame(reference, game)).toBe(true);
    for (const conflict of [
        { white: "Beerdsen, Alice" },
        { black: "Deac, Bogdan" },
        { white_elo: 2519 },
        { black_elo: null },
        { result: "1-0" as const },
        { date: "2021.12.01" },
        { round: "4" },
        { event: "Another tournament" },
        { site: "Another city" },
    ]) {
        expect(matchesReferenceGame(reference, { ...game, ...conflict })).toBe(false);
    }
});

test("uses database-local IDs, ordered sides and outcome without premature date filters", async () => {
    const { api, search } = setup();
    const result = await search();
    expect(result.complete).toBe(true);
    expect(result.candidates).toEqual([
        { database, source: "Source A (source-a.db3)", game, verification: "verified" },
    ]);
    expect(api.query_games).toHaveBeenCalledWith(
        database,
        expect.objectContaining({
            player1: 11,
            player2: 22,
            sides: "WhiteBlack",
            outcome: "0-1",
            options: expect.objectContaining({ page: 1, pageSize: 100 }),
        }),
        expect.anything(),
    );
    expect(api.query_games.mock.calls[0][1].startDate).toBeUndefined();
    expect(api.query_games.mock.calls[0][1].endDate).toBeUndefined();
});

test("reads later player and game pages before establishing uniqueness", async () => {
    const { api, search } = setup();
    api.query_players.mockImplementation(async (_db, query) =>
        query.name === "Bluebaum"
            ? { data: [{ id: 22, name: game.black, game_count: 0, elo: 2651 }], count: 1 }
            : {
                  data:
                      query.options.page === 1
                          ? Array.from(
                                { length: 100 },
                                (_, id): Player => ({
                                    id: id + 100,
                                    name: "Beerdsenberg, Thomas",
                                    game_count: 0,
                                    elo: 2520,
                                }),
                            )
                          : [{ id: 11, name: game.white, game_count: 0, elo: 2520 }],
                  count: 101,
              },
    );
    api.query_games.mockImplementation(async (_db, query) => ({
        data:
            query.options?.page === 1
                ? [
                      game,
                      ...Array.from({ length: 99 }, (_, id) => ({
                          ...game,
                          id: id + 100,
                          round: "9",
                      })),
                  ]
                : [{ ...game, id: 2 }],
        count: 101,
    }));
    const result = await search();
    expect(result.complete).toBe(true);
    expect(result.candidates.map((entry) => entry.game.id)).toEqual([1, 2]);
    expect(api.query_games).toHaveBeenCalledTimes(2);
});

test("keeps distinct source-qualified occurrences even with the same game ID", async () => {
    const { library, search } = setup();
    library.databases.push({
        ...library.databases[0],
        file: { ...database, id: { id: "source-b" } },
    });
    expect((await search()).candidates).toHaveLength(2);
});

test("empty Library is a complete no-match", async () => {
    const { library, search } = setup();
    library.databases = [];
    expect(await search()).toEqual({ candidates: [], failures: [], complete: true });
});

test("trashed non-account sources do not produce reference failures", async () => {
    const { library, search } = setup();
    library.collections = [
        {
            id: "trashed",
            name: "Trashed",
            file: { id: { id: "pgn" }, kind: "fileWorkspace" },
            database: null,
            account: null,
            status: "trashed",
            generation: "",
            omitted: 3,
            retiredDatabase: null,
            fetchSinceMs: null,
        },
    ];
    expect((await search()).failures).toEqual([]);
    library.collections![0].account = { provider: "lichess", account: "player" };
    expect((await search()).failures).toContainEqual({
        source: "Trashed",
        category: "unavailable",
    });
});

test("preserves unread, unavailable and omitted source guidance alongside successful candidates", async () => {
    const { library, search } = setup();
    library.unread.push({ filename: "Unread", error: "Select this source again" });
    library.databases.push({
        type: "error",
        file: database,
        filename: "Broken",
        error: "Permission guidance",
        indexed: false,
    });
    library.collections = [
        {
            id: "collection",
            name: "Collection",
            file: { id: { id: "pgn" }, kind: "fileWorkspace" },
            database: null,
            account: null,
            status: "unavailable",
            generation: "1",
            omitted: 1,
            retiredDatabase: null,
            fetchSinceMs: null,
        },
    ];
    const result = await search();
    expect(result.complete).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.failures).toEqual(
        expect.arrayContaining([
            { source: "Unread", category: "unavailable", message: "Select this source again" },
            { source: "Broken", category: "unavailable", message: "Permission guidance" },
            { source: "Collection", category: "omitted" },
            { source: "Collection", category: "unavailable" },
        ]),
    );
});

test.each(["upgrading", "busy"] as const)(
    "retains the %s message as unavailable without querying the transient source",
    async (transient) => {
        const { library, api, search } = setup();
        const error =
            transient === "upgrading"
                ? "This database is being upgraded to the current format. Large databases can take several minutes."
                : "This database is in use and cannot be read right now. It is retried automatically.";
        library.databases = [
            {
                type: "error",
                file: database,
                filename: "held.db3",
                indexed: false,
                transient,
                error,
            },
        ];
        const result = await search();
        expect(result.complete).toBe(false);
        expect(result.candidates).toEqual([]);
        expect(result.failures).toEqual([
            { source: "held.db3", category: "unavailable", message: error },
        ]);
        expect(api.query_players).not.toHaveBeenCalled();
        expect(api.query_games).not.toHaveBeenCalled();
    },
);

test.each(["permission", "missing-resource", "database"] as const)(
    "retains safe %s category without exposing native diagnostics",
    async (category) => {
        const { api, search } = setup();
        api.query_games.mockRejectedValueOnce({
            tag: "backend-error",
            category,
            message: "secret raw native diagnostic",
        });
        const result = await search();
        expect(result.complete).toBe(false);
        expect(result.failures[0]).toEqual({
            source: "Source A (source-a.db3)",
            backendCategory: category,
            category:
                category === "missing-resource"
                    ? "not-found"
                    : category === "permission"
                      ? "permission"
                      : "unexpected",
        });
        expect(JSON.stringify(result)).not.toContain("diagnostic");
        expect((await search()).complete).toBe(true);
    },
);

test("discovery failure is incomplete even without candidates", async () => {
    const { api, search } = setup();
    api.getDatabases.mockRejectedValueOnce(new Error("permission denied"));
    expect(await search()).toMatchObject({
        complete: false,
        failures: [{ source: "", category: "permission" }],
    });
});

test("unknown month and day remain eligible when the year is identifiable", async () => {
    const { api, search } = setup();
    api.query_games.mockResolvedValue({ data: [{ ...game, date: "2022.??.??" }], count: 1 });
    expect((await search()).candidates).toHaveLength(1);
    expect(api.query_games.mock.calls[0][1].startDate).toBeUndefined();
    expect(api.query_games.mock.calls[0][1].endDate).toBeUndefined();
});

test("Unicode discovery uses invariant ASCII fragments and supports stored dotted initials", async () => {
    const { api } = setup();
    const unicode = recognizeGameReferences("1-0 Šarić,I.K.-O'Kelly,A 2022 (3)")[0];
    api.query_players.mockResolvedValue({
        data: [
            { id: 1, name: "Šarić,I.K.", game_count: 0, elo: null },
            { id: 2, name: "O’Kelly, Andrew", game_count: 0, elo: null },
        ],
        count: 2,
    });
    api.query_games.mockResolvedValue({
        data: [{ ...game, white: "Šarić,I.K.", black: "O’Kelly, Andrew", result: "1-0" }],
        count: 1,
    });
    const result = await lookupGameReference(unicode, new AbortController().signal, api);
    expect(result.complete).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(api.query_players.mock.calls.map((call) => call[1].name)).toEqual(["ari", "Kelly"]);
});

test.each(["Tõnisson", "To\u0303nisson", "TÕNISSON"])(
    "selectively discovers %s beyond the all-player budget in a large source",
    async (surname) => {
        const { library, api } = setup();
        const targetId = REFERENCE_SEARCH_LIMITS.requests * REFERENCE_SEARCH_LIMITS.pageSize + 1;
        const white = {
            id: targetId,
            name: "TÕNISSON, Tõnu".normalize("NFD"),
            game_count: 0,
            elo: 2520,
        };
        const black = { id: targetId + 1, name: game.black, game_count: 0, elo: 2651 };
        const largeGame = { ...game, white: white.name, white_id: white.id, black_id: black.id };
        if (library.databases[0].type === "success")
            library.databases[0].player_count = targetId + 1;
        api.query_players.mockImplementation(async (_db, query) => {
            if (query.name) {
                const matches = [white, black].filter((player) =>
                    player.name.toLowerCase().includes(query.name!.toLowerCase()),
                );
                return { data: matches, count: matches.length };
            }
            const start = ((query.options.page ?? 1) - 1) * REFERENCE_SEARCH_LIMITS.pageSize;
            return {
                data: Array.from(
                    { length: Math.min(REFERENCE_SEARCH_LIMITS.pageSize, targetId + 1 - start) },
                    (_, index) => {
                        const id = start + index + 1;
                        return id === white.id
                            ? white
                            : id === black.id
                              ? black
                              : { id, name: "Unrelated, A", game_count: 0, elo: null };
                    },
                ),
                count: targetId + 1,
            };
        });
        api.query_games.mockResolvedValue({ data: [largeGame], count: 1 });
        const citation = recognizeGameReferences(
            `0-1 ${surname},T (2520)-Bluebaum,M (2651) 2022 (3)`,
        )[0];
        const result = await lookupGameReference(citation, new AbortController().signal, api);
        expect(result.complete).toBe(true);
        expect(result.candidates).toEqual([
            {
                database,
                source: "Source A (source-a.db3)",
                game: largeGame,
                verification: "verified",
            },
        ]);
        expect(api.query_players).toHaveBeenCalledTimes(2);
        expect(api.query_players.mock.calls.map((call) => call[1].name?.toLowerCase())).toEqual([
            "nisson",
            "bluebaum",
        ]);
        expect(api.query_games.mock.calls[0][1]).toMatchObject({
            player1: targetId,
            player2: targetId + 1,
            sides: "WhiteBlack",
        });
    },
);

test("surnames without an ASCII run fall back to bounded full player queries", async () => {
    const { api } = setup();
    api.query_players.mockResolvedValue({
        data: [
            { id: 1, name: "李, Lin", game_count: 0, elo: null },
            { id: 2, name: "王, Wei", game_count: 0, elo: null },
        ],
        count: 2,
    });
    api.query_games.mockResolvedValue({
        data: [{ ...game, white: "李, Lin", black: "王, Wei" }],
        count: 1,
    });
    const citation = recognizeGameReferences("0-1 李,L-王,W")[0];
    const result = await lookupGameReference(citation, new AbortController().signal, api);
    expect(result.complete).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(api.query_players.mock.calls.map((call) => call[1].name)).toEqual([
        undefined,
        undefined,
    ]);
});

test("bounded failure retention never hides an incomplete search", async () => {
    const { library, search } = setup();
    library.unread = Array.from({ length: 101 }, (_, index) => ({
        filename: `Unread ${index}`,
        error: "Unread source",
    }));
    const result = await search();
    expect(result.complete).toBe(false);
    expect(result.failures).toHaveLength(REFERENCE_SEARCH_LIMITS.failures);
    expect(result.failures.at(-1)).toEqual({ source: "", category: "budget" });
});

test("request and retention limits remain visibly incomplete", async () => {
    const { api, search } = setup();
    api.query_players.mockResolvedValue({
        data: Array.from({ length: 100 }, (_, id) => ({
            id,
            name: "Unrelated, A",
            game_count: 0,
            elo: null,
        })),
        count: null,
    });
    const result = await search();
    expect(api.query_players).toHaveBeenCalledTimes(REFERENCE_SEARCH_LIMITS.requests);
    expect(result).toMatchObject({
        complete: false,
        failures: [{ source: "Source A (source-a.db3)", category: "budget" }],
    });
    const next = setup();
    next.api.query_games.mockImplementation(async (_db, query) => ({
        data: Array.from({ length: 100 }, (_, id) => ({
            ...game,
            id: ((query.options?.page ?? 1) - 1) * 100 + id,
        })),
        count: 200,
    }));
    const bounded = await next.search();
    expect(bounded.candidates).toHaveLength(100);
    expect(bounded.complete).toBe(false);
});

test("an empty page before the advertised count retains a candidate without automatic opening", async () => {
    const { api, search } = setup();
    api.query_games.mockImplementation(async (_database, query) => ({
        data:
            query.options?.page === 1
                ? [
                      game,
                      ...Array.from({ length: 99 }, (_, index) => ({
                          ...game,
                          id: index + 2,
                          round: "9",
                      })),
                  ]
                : [],
        count: 301,
    }));
    const result = await search();
    expect(result.candidates).toEqual([
        { database, source: "Source A (source-a.db3)", game, verification: "verified" },
    ]);
    expect(api.query_games.mock.calls.map((call) => call[1].options)).toEqual([
        { page: 1, pageSize: 100, sort: "id", direction: "asc", skipCount: false },
        { page: 2, pageSize: 100, sort: "id", direction: "asc", skipCount: false },
    ]);
    expect(result.complete).toBe(false);
    expect(result.failures).toEqual([{ source: "Source A (source-a.db3)", category: "budget" }]);
    await lookupUI(beerdsen, api, (host) => {
        expect(admission.create).not.toHaveBeenCalled();
        expect(host.textContent).toContain("GameReferences.Incomplete");
        expect(host.textContent).toContain("GameReferences.Failure.budget");
        expect(host.textContent).toContain("GameReferences.Choose");
    });
});

test("more than 64 sources stop traversal and visibly preserve incomplete unique results", async () => {
    const { library, api, search } = setup();
    const source = library.databases[0];
    if (source.type !== "success") throw new Error("Expected an available fixture source");
    library.databases = Array.from({ length: 65 }, (_, index) => ({
        ...source,
        file: { ...database, id: { id: `source-${index}` } },
        filename: `Source ${index}`,
        title: `Source ${index}`,
    }));
    api.query_games.mockImplementation(async (file) => {
        const data = file.id.id === "source-0" || file.id.id === "source-64" ? [game] : [];
        return { data, count: data.length };
    });
    const result = await search();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ source: "Source 0", verification: "verified" });
    expect(api.query_games.mock.calls.map((call) => call[0].id.id)).toEqual(
        Array.from({ length: 64 }, (_, index) => `source-${index}`),
    );
    expect(api.query_players).toHaveBeenCalledTimes(128);
    expect(result.complete).toBe(false);
    expect(result.failures).toEqual([{ source: "", category: "budget" }]);
    await lookupUI(beerdsen, api, (host) => {
        expect(admission.create).not.toHaveBeenCalled();
        expect(host.textContent).toContain("GameReferences.Incomplete");
        expect(host.textContent).toContain("GameReferences.Library: GameReferences.Failure.budget");
        expect(host.textContent).toContain("GameReferences.Choose");
    });
});

test("more than 256 matching player IDs stop retention and visibly preserve incomplete results", async () => {
    const { library, api, search } = setup();
    const source = library.databases[0];
    if (source.type !== "success") throw new Error("Expected an available fixture source");
    library.databases.push({
        ...source,
        file: { ...database, id: { id: "crowded" } },
        filename: "Crowded",
        title: "Crowded",
    });
    const players: Player[] = Array.from({ length: 401 }, (_, index) => ({
        id: index + 1,
        name: "Beerdsen, Thomas",
        game_count: 0,
        elo: null,
    }));
    api.query_players.mockImplementation(async (file, query) => {
        const matching =
            file.id.id === "crowded"
                ? query.name === "Beerdsen"
                    ? players
                    : []
                : [
                      { id: 11, name: game.white, game_count: 0, elo: null },
                      { id: 22, name: game.black, game_count: 0, elo: null },
                  ].filter((player) => player.name.includes(query.name!));
        const start = ((query.options.page ?? 1) - 1) * query.options.pageSize!;
        return {
            data: matching.slice(start, start + query.options.pageSize!),
            count: matching.length,
        };
    });
    api.query_games.mockImplementation(async (file, query) => {
        const data =
            file.id.id === database.id.id && query.player1 === 11 && query.player2 === 22
                ? [game]
                : [];
        return { data, count: data.length };
    });
    const result = await search();
    expect(result.candidates).toEqual([
        { database, source: "Source A (source-a.db3)", game, verification: "verified" },
    ]);
    expect(
        api.query_players.mock.calls
            .filter(([file, query]) => file.id.id === "crowded" && query.name === "Beerdsen")
            .map(([, query]) => query.options),
    ).toEqual([
        { page: 1, pageSize: 100, sort: "id", direction: "asc", skipCount: false },
        { page: 2, pageSize: 100, sort: "id", direction: "asc", skipCount: false },
        { page: 3, pageSize: 100, sort: "id", direction: "asc", skipCount: false },
    ]);
    expect(api.query_games).toHaveBeenCalledTimes(1);
    expect(result.complete).toBe(false);
    expect(result.failures).toEqual([{ source: "Crowded", category: "budget" }]);
    await lookupUI(beerdsen, api, (host) => {
        expect(admission.create).not.toHaveBeenCalled();
        expect(host.textContent).toContain("GameReferences.Incomplete");
        expect(host.textContent).toContain("Crowded: GameReferences.Failure.budget");
        expect(host.textContent).toContain("GameReferences.Choose");
    });
});

test("aborted lookup rejects after late native responses", async () => {
    const { api, search } = setup();
    const controller = new AbortController();
    api.query_games.mockImplementationOnce(async () => {
        controller.abort();
        return { data: [game], count: 1 };
    });
    await expect(search(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});
