import { describe, expect, test } from "vitest";
import { defaultTree, getBoardState } from "@/utils/treeReducer";
import {
    getMoveLine,
    getTranspositionTarget,
    type FileChapterOccurrence,
    type OpenChapterOccurrence,
    type OpenMoveLine,
    type TranspositionTarget,
} from "./transpositionTarget";

const START_KEY = getBoardState("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
const AFTER_E4_KEY = getBoardState("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");

type RuleCase = {
    name: string;
    move: OpenMoveLine;
    openOccurrences: OpenChapterOccurrence[];
    fileOccurrences: FileChapterOccurrence[];
    expected: TranspositionTarget | undefined;
};

describe("getTranspositionTarget", () => {
    const cases: RuleCase[] = [
        {
            name: "returns undefined for the root path",
            move: { path: [], rootKey: START_KEY, moveOrder: "", chapter: 0 },
            openOccurrences: [{ path: [1, 0], hasContinuation: true }],
            fileOccurrences: [
                {
                    chapter: 1,
                    chapterName: "Ch 2",
                    path: [0],
                    hasContinuation: true,
                    rootKey: AFTER_E4_KEY,
                    moveOrder: "",
                },
            ],
            expected: undefined,
        },
        {
            name: "open-chapter analysed target wins over a later chapter's analysed target",
            move: { path: [0, 0, 0], rootKey: START_KEY, moveOrder: "e4 e5 Nf3", chapter: 0 },
            openOccurrences: [
                { path: [0, 0, 0], hasContinuation: true },
                { path: [1, 0, 0], hasContinuation: true },
            ],
            fileOccurrences: [
                {
                    chapter: 1,
                    chapterName: "Vienna",
                    path: [0, 0, 0],
                    hasContinuation: true,
                    rootKey: START_KEY,
                    moveOrder: "Nf3 e5 e4",
                },
            ],
            expected: { scope: "chapter", path: [1, 0, 0] },
        },
        {
            name: "analysed occurrence in another chapter wins over an empty one in the open chapter",
            move: { path: [0, 0, 0], rootKey: START_KEY, moveOrder: "e4 e5 Nf3", chapter: 0 },
            openOccurrences: [
                { path: [0, 0, 0], hasContinuation: false },
                { path: [1, 0, 0], hasContinuation: false },
            ],
            fileOccurrences: [
                {
                    chapter: 2,
                    chapterName: "Italian",
                    path: [0, 0, 0],
                    hasContinuation: true,
                    rootKey: START_KEY,
                    moveOrder: "Nf3 e5 e4",
                },
            ],
            expected: { scope: "file", chapter: 2, chapterName: "Italian", path: [0, 0, 0] },
        },
        {
            name: "shared move order in another chapter is no target, including differently spelled roots",
            move: {
                path: [0],
                rootKey: getBoardState("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b HAha -"),
                moveOrder: "e5",
                chapter: 0,
            },
            openOccurrences: [],
            fileOccurrences: [
                {
                    chapter: 1,
                    chapterName: "Duplicate line",
                    path: [1, 0],
                    hasContinuation: true,
                    rootKey: getBoardState(
                        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 7 25",
                    ),
                    moveOrder: "e5",
                },
            ],
            expected: undefined,
        },
        {
            name: "same moveOrder from a different starting position in another chapter is a target",
            move: { path: [0], rootKey: START_KEY, moveOrder: "e4", chapter: 0 },
            openOccurrences: [],
            fileOccurrences: [
                {
                    chapter: 1,
                    chapterName: "Setup position",
                    path: [0],
                    hasContinuation: true,
                    rootKey: AFTER_E4_KEY,
                    moveOrder: "e4",
                },
            ],
            expected: { scope: "file", chapter: 1, chapterName: "Setup position", path: [0] },
        },
        {
            name: "different move order to the same position in another chapter is a target",
            move: { path: [0, 0, 0], rootKey: START_KEY, moveOrder: "e4 e5 Nf3", chapter: 0 },
            openOccurrences: [],
            fileOccurrences: [
                {
                    chapter: 1,
                    chapterName: "Transposed",
                    path: [0, 0, 0],
                    hasContinuation: false,
                    rootKey: START_KEY,
                    moveOrder: "Nf3 e5 e4",
                },
            ],
            expected: { scope: "file", chapter: 1, chapterName: "Transposed", path: [0, 0, 0] },
        },
        {
            name: "another chapter's root is a target for a move that reaches its start position",
            move: { path: [0], rootKey: START_KEY, moveOrder: "e4", chapter: 0 },
            openOccurrences: [],
            fileOccurrences: [
                {
                    chapter: 3,
                    chapterName: "1.e4 Tabiya",
                    path: [],
                    hasContinuation: true,
                    rootKey: AFTER_E4_KEY,
                    moveOrder: "",
                },
            ],
            expected: { scope: "file", chapter: 3, chapterName: "1.e4 Tabiya", path: [] },
        },
        {
            name: "ignores occurrences from the open chapter's own number",
            move: { path: [0, 0, 0], rootKey: START_KEY, moveOrder: "e4 e5 Nf3", chapter: 2 },
            openOccurrences: [],
            fileOccurrences: [
                {
                    chapter: 2,
                    chapterName: "Open chapter stale copy",
                    path: [1, 0, 0],
                    hasContinuation: true,
                    rootKey: START_KEY,
                    moveOrder: "Nf3 e5 e4",
                },
                {
                    chapter: 4,
                    chapterName: "Other chapter",
                    path: [0, 0, 0],
                    hasContinuation: false,
                    rootKey: START_KEY,
                    moveOrder: "Nf3 e5 e4",
                },
            ],
            expected: { scope: "file", chapter: 4, chapterName: "Other chapter", path: [0, 0, 0] },
        },
        {
            name: "ignores self, ancestors, and descendants on the move's own line and returns undefined when none remain",
            move: { path: [0, 0], rootKey: START_KEY, moveOrder: "e4 e5", chapter: 0 },
            openOccurrences: [
                { path: [], hasContinuation: true },
                { path: [0], hasContinuation: true },
                { path: [0, 0], hasContinuation: true },
                { path: [0, 0, 0, 0], hasContinuation: true },
            ],
            fileOccurrences: [],
            expected: undefined,
        },
        {
            name: "orders other chapters by chapter number when picking among file candidates",
            move: { path: [0, 0, 0], rootKey: START_KEY, moveOrder: "e4 e5 Nf3", chapter: 0 },
            openOccurrences: [],
            fileOccurrences: [
                {
                    chapter: 3,
                    chapterName: "Later",
                    path: [0, 0, 0],
                    hasContinuation: true,
                    rootKey: START_KEY,
                    moveOrder: "Nf3 e5 e4",
                },
                {
                    chapter: 1,
                    chapterName: "Earlier",
                    path: [0, 0, 0],
                    hasContinuation: true,
                    rootKey: START_KEY,
                    moveOrder: "e4 Nf6 Nf3",
                },
            ],
            expected: { scope: "file", chapter: 1, chapterName: "Earlier", path: [0, 0, 0] },
        },
        {
            name: "when no candidate continues, first open-chapter candidate wins over file candidates",
            move: { path: [0, 0, 0], rootKey: START_KEY, moveOrder: "e4 e5 Nf3", chapter: 0 },
            openOccurrences: [{ path: [1, 0, 0], hasContinuation: false }],
            fileOccurrences: [
                {
                    chapter: 1,
                    chapterName: "Other",
                    path: [0, 0, 0],
                    hasContinuation: false,
                    rootKey: START_KEY,
                    moveOrder: "Nf3 e5 e4",
                },
            ],
            expected: { scope: "chapter", path: [1, 0, 0] },
        },
    ];

    test.each(cases)("$name", ({ move, openOccurrences, fileOccurrences, expected }) => {
        expect(getTranspositionTarget(move, openOccurrences, fileOccurrences)).toEqual(expected);
    });
});

test("getMoveLine derives normalized rootKey and SAN sequence along path", () => {
    const fourField = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b HAha -";
    const tree = defaultTree(fourField);
    tree.root.children = [
        {
            ...defaultTree().root,
            san: "e5",
            children: [{ ...defaultTree().root, san: "Nf3", children: [] }],
        },
        {
            ...defaultTree().root,
            san: "c5",
            children: [],
        },
    ];

    expect(getMoveLine(tree.root, [0, 0])).toEqual({
        rootKey: AFTER_E4_KEY,
        moveOrder: "e5 Nf3",
    });
    expect(getMoveLine(tree.root, [1])).toEqual({
        rootKey: AFTER_E4_KEY,
        moveOrder: "c5",
    });
});
