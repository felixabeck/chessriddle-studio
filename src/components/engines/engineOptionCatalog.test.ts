import i18n from "i18next";
import { describe, expect, test } from "vitest";
import { getEngineOptionPresentation } from "./engineOptionCatalog";

const expected = [
    [
        "Threads",
        "CPU threads",
        "How many processor cores the engine uses. More cores make analysis faster.",
        "CPU-Threads",
        "Wie viele Prozessorkerne die Engine nutzt. Mehr Kerne machen die Analyse schneller.",
    ],
    [
        "Hash",
        "Memory (MB)",
        "Memory for positions the engine has already calculated. More helps long analyses; stay well below your free RAM.",
        "Arbeitsspeicher (MB)",
        "Speicher für bereits berechnete Stellungen. Mehr hilft bei langen Analysen; bleib deutlich unter deinem freien Arbeitsspeicher.",
    ],
    [
        "MultiPV",
        "Number of lines",
        "How many best moves the engine shows at once. More lines make each one a little less deep.",
        "Anzahl der Varianten",
        "Wie viele beste Züge die Engine gleichzeitig zeigt. Mehr Varianten rechnen jede einzelne etwas weniger tief.",
    ],
    [
        "UCI_ShowWDL",
        "Show win/draw/loss chances",
        "Shows the chances of a win, draw or loss next to the evaluation.",
        "Gewinn-/Remis-/Verlustchancen zeigen",
        "Zeigt neben der Bewertung die Chancen auf Gewinn, Remis oder Verlust.",
    ],
    [
        "SyzygyPath",
        "Endgame tablebase folders",
        "Folders with Syzygy tablebases. With them the engine plays endgames with few pieces perfectly.",
        "Ordner der Endspieldatenbanken",
        "Ordner mit Syzygy-Endspieldatenbanken. Damit spielt die Engine Endspiele mit wenigen Steinen perfekt.",
    ],
    [
        "SyzygyProbeDepth",
        "Tablebase probe depth",
        "Minimum search depth before the engine asks the tablebases. Raise it if they are on a slow drive.",
        "Abfragetiefe der Endspieldatenbanken",
        "Mindesttiefe, ab der die Engine die Endspieldatenbanken abfragt. Erhöhe sie, wenn sie auf einem langsamen Laufwerk liegen.",
    ],
    [
        "SyzygyProbeLimit",
        "Tablebase piece limit",
        "The engine uses the tablebases only with at most this many pieces on the board.",
        "Steinlimit der Endspieldatenbanken",
        "Die Engine nutzt die Endspieldatenbanken nur bei höchstens so vielen Steinen auf dem Brett.",
    ],
    [
        "Syzygy50MoveRule",
        "Respect the 50-move rule",
        "Counts tablebase wins that need more than 50 moves as draws, as in real games.",
        "50-Züge-Regel beachten",
        "Wertet Gewinne aus den Endspieldatenbanken, die mehr als 50 Züge brauchen, wie in echten Partien als Remis.",
    ],
    [
        "EvalFile",
        "Evaluation network",
        "Replaces the neural network the engine uses to judge positions. Leave it unless you need a specific one.",
        "Bewertungsnetz",
        "Ersetzt das neuronale Netz, mit dem die Engine Stellungen bewertet. Lass es so, außer du brauchst gezielt ein anderes.",
    ],
    [
        "EvalFileSmall",
        "Small evaluation network",
        "Replaces the second, faster network. Leave it unless you need a specific one.",
        "Kleines Bewertungsnetz",
        "Ersetzt das zweite, schnellere Netz. Lass es so, außer du brauchst gezielt ein anderes.",
    ],
    [
        "Skill Level",
        "Skill level",
        "Makes the engine play weaker on purpose (0 = weakest, 20 = full strength). Only matters when it plays against you.",
        "Spielstärke-Stufe",
        "Lässt die Engine absichtlich schwächer spielen (0 = am schwächsten, 20 = volle Stärke). Wirkt nur, wenn sie gegen dich spielt.",
    ],
    [
        "UCI_LimitStrength",
        "Limit strength to an Elo rating",
        "Makes the engine play at the target Elo below. Only matters when it plays against you.",
        "Spielstärke auf eine Elo-Zahl begrenzen",
        "Lässt die Engine mit der Ziel-Elo darunter spielen. Wirkt nur, wenn sie gegen dich spielt.",
    ],
    [
        "UCI_Elo",
        "Target Elo",
        "The playing strength the engine aims for while the limit is on.",
        "Ziel-Elo",
        "Die Spielstärke, die die Engine bei aktiver Begrenzung anstrebt.",
    ],
    [
        "Ponder",
        "Think on your time",
        "The engine keeps thinking while it waits for your move. Only matters when it plays.",
        "In deiner Bedenkzeit rechnen",
        "Die Engine rechnet weiter, während sie auf deinen Zug wartet. Wirkt nur, wenn sie spielt.",
    ],
    [
        "Move Overhead",
        "Move overhead (ms)",
        "Time kept back per move for delays in the app or network, so the engine does not lose on time.",
        "Zeitpuffer pro Zug (ms)",
        "Zeit, die die Engine pro Zug für Verzögerungen in App oder Netzwerk zurückhält, damit sie nicht auf Zeit verliert.",
    ],
    [
        "nodestime",
        "Nodes as time",
        "Testing setting: counts thinking time in calculated positions instead of seconds. Keep 0.",
        "Knoten als Zeit",
        "Testeinstellung: zählt Bedenkzeit in berechneten Stellungen statt in Sekunden. Bei 0 lassen.",
    ],
    [
        "NumaPolicy",
        "Processor memory policy",
        "How threads are spread across processors on machines with several CPUs. Keep “auto”.",
        "Prozessor-Speicherrichtlinie",
        "Wie die Engine Threads auf Rechnern mit mehreren Prozessoren verteilt. Bei „auto“ lassen.",
    ],
    [
        "UCI_Chess960",
        "Chess960",
        "Fischer Random rules. The app switches this on by itself for Chess960 games.",
        "Chess960",
        "Regeln für Fischer-Random-Schach. Die App schaltet das bei Chess960-Partien selbst ein.",
    ],
    [
        "Debug Log File",
        "Debug log file",
        "Writes all communication with the engine to a file. Only needed to diagnose problems.",
        "Debug-Logdatei",
        "Schreibt die gesamte Kommunikation mit der Engine in eine Datei. Nur zur Fehlersuche nötig.",
    ],
] as const;

for (const locale of ["en-US", "de-DE"] as const) {
    describe(`shipped ${locale} option copy without fallback`, () => {
        test.each(expected)(
            "%s has exact copy, tier and case-insensitive matching",
            async (name, enLabel, enDescription, deLabel, deDescription) => {
                const { default: catalogue } = await import(`../../translation/${locale}.json`);
                const translator = i18n.createInstance();
                await translator.init({
                    lng: locale,
                    fallbackLng: false,
                    resources: { [locale]: catalogue },
                });
                const presentation = {
                    tier: ["Threads", "Hash", "MultiPV", "UCI_ShowWDL"].includes(name)
                        ? "essential"
                        : "expert",
                    label: locale === "en-US" ? enLabel : deLabel,
                    description: locale === "en-US" ? enDescription : deDescription,
                };
                for (const casing of [name, name.toUpperCase(), name.toLowerCase()]) {
                    expect(getEngineOptionPresentation(casing, translator.t)).toEqual(presentation);
                }
            },
        );
        test("unknown options keep their name and stay essential", async () => {
            const translator = i18n.createInstance();
            await translator.init({ lng: locale, fallbackLng: false });
            expect(getEngineOptionPresentation("Custom Engine Option", translator.t)).toEqual({
                tier: "essential",
                label: "Custom Engine Option",
            });
        });
        test("expert toggle is translated", async () => {
            const { default: catalogue } = await import(`../../translation/${locale}.json`);
            const translator = i18n.createInstance();
            await translator.init({
                lng: locale,
                fallbackLng: false,
                resources: { [locale]: catalogue },
            });
            expect(translator.t("Engines.Settings.ExpertSettings", { count: 12 })).toBe(
                locale === "en-US" ? "Expert settings (12)" : "Experteneinstellungen (12)",
            );
        });
    });
}
