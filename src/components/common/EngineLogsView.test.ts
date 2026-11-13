import { expect, test } from "vitest";
import { engineLogsCsv, truncatedLogCount } from "./EngineLogsView";

test("counts only explicit engine-log truncation metadata", () => {
    expect(
        truncatedLogCount([
            { type: "gui", value: "started" },
            { type: "engine", value: "info depth 16" },
            { type: "truncated", value: { droppedEntries: 3n } },
            { type: "truncated", value: { droppedEntries: 4n } },
        ]),
    ).toBe(7);
});

test("reports no truncation metadata when every entry is a real log line", () => {
    expect(truncatedLogCount([{ type: "engine", value: "readyok" }])).toBe(0);
});

test("quotes CSV fields that contain commas and quotes", () => {
    expect(
        engineLogsCsv(
            [
                { type: "engine", value: "info string NNUE (133MiB, (22528, 3072))" },
                { type: "gui", value: 'setoption name Foo value "a,b"' },
            ],
            (count) => `${count} older log entries omitted`,
        ),
    ).toBe(
        `"engine","info string NNUE (133MiB, (22528, 3072))"\n"gui","setoption name Foo value ""a,b"""`,
    );
});

test("quotes a truncated metadata row", () => {
    expect(
        engineLogsCsv(
            [{ type: "truncated", value: { droppedEntries: 3n } }],
            (count) => `${count} older log entries omitted`,
        ),
    ).toBe(`"metadata","3 older log entries omitted"`);
});
