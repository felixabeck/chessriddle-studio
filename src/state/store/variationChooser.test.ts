import { expect, test, vi } from "vitest";
import { closeTreeStore, createTreeStore, nextContinuation } from "@/state/store/tree";
import {
    createVariationChooserStore,
    subscribeVariationChooser,
} from "@/state/store/variationChooser";
import { fixtureNode } from "@/tests/treeFixtures";
import { defaultTree } from "@/utils/treeReducer";

vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));

test.each([
    {
        input: "position",
        unchanged: ["root"] as const,
        change: (tree: ReturnType<typeof createTreeStore>) => tree.getState().goToMove([0]),
    },
    {
        input: "headers.start",
        unchanged: ["position", "root"] as const,
        change: (tree: ReturnType<typeof createTreeStore>) => tree.getState().setStart([0]),
    },
    {
        input: "practicePath",
        unchanged: ["position", "root"] as const,
        change: (tree: ReturnType<typeof createTreeStore>) => tree.getState().setPracticePath([1]),
    },
])("closes when $input changes", ({ unchanged, change }) => {
    const initial = defaultTree();
    initial.root.children = [fixtureNode("e4"), fixtureNode("d4")];
    const tree = createTreeStore(undefined, initial);
    const chooser = createVariationChooserStore();
    const unsubscribe = subscribeVariationChooser(tree, chooser);
    chooser.getState().open(tree.getState().root.children);
    const previous = tree.getState();
    change(tree);
    expect(chooser.getState().choice).toBeNull();
    for (const field of unchanged) expect(tree.getState()[field]).toBe(previous[field]);
    unsubscribe();
});

test.each([
    {
        input: "engine score",
        change: (tree: ReturnType<typeof createTreeStore>) =>
            tree.getState().setEngineScore({ value: { type: "cp", value: 42 }, wdl: null }),
    },
    {
        input: "comment",
        change: (tree: ReturnType<typeof createTreeStore>) => tree.getState().setComment("changed"),
    },
])("keeps the choice and selection when the current node's $input changes", ({ change }) => {
    const initial = defaultTree();
    initial.root.children = [fixtureNode("e4"), fixtureNode("d4")];
    const tree = createTreeStore(undefined, initial);
    const chooser = createVariationChooserStore();
    const unsubscribe = subscribeVariationChooser(tree, chooser);
    chooser.getState().open(nextContinuation(tree.getState())!.children);
    chooser.getState().selectIndex(1);
    const choice = chooser.getState().choice;
    const previous = tree.getState();

    change(tree);

    expect(tree.getState().root).not.toBe(previous.root);
    for (const field of ["position", "headers", "practicePath"] as const) {
        expect(tree.getState()[field]).toBe(previous[field]);
    }
    expect(chooser.getState().choice).toBe(choice);
    expect(chooser.getState().choice?.selected).toBe(1);
    expect(chooser.getState().choice?.children).toBe(nextContinuation(tree.getState())!.children);
    unsubscribe();
});

test("keeps the choice when a score write copies a transposed ancestor's continuations", () => {
    const tree = createTreeStore();
    tree.getState().makeMove({ payload: "d4", changePosition: false, changeHeaders: false });
    expect(
        tree.getState().makeMoves({
            payload: ["Nf3", "Nf6", "Ng1", "Ng8"],
            changeHeaders: false,
        }).success,
    ).toBe(true);
    expect(tree.getState().position).toEqual([1, 0, 0, 0]);
    const openedChildren = nextContinuation(tree.getState())!.children;
    expect(openedChildren).toBe(tree.getState().root.children);
    expect(openedChildren.map((child) => child.san)).toEqual(["d4", "Nf3"]);
    const chooser = createVariationChooserStore();
    const unsubscribe = subscribeVariationChooser(tree, chooser);
    chooser.getState().open(openedChildren);
    chooser.getState().selectIndex(1);
    const choice = chooser.getState().choice;
    const previous = tree.getState();

    tree.getState().setEngineScore({ value: { type: "cp", value: 15 }, wdl: null });

    expect(tree.getState().root).not.toBe(previous.root);
    for (const field of ["position", "headers", "practicePath"] as const) {
        expect(tree.getState()[field]).toBe(previous[field]);
    }
    const liveChildren = nextContinuation(tree.getState())!.children;
    expect(liveChildren).not.toBe(openedChildren);
    expect(liveChildren.map((child) => child.san)).toEqual(["d4", "Nf3"]);
    expect(chooser.getState().choice).toBe(choice);
    expect(chooser.getState().choice?.selected).toBe(1);
    expect(chooser.getState().choice?.children).toBe(openedChildren);
    expect(chooser.getState().choice?.children.map((child) => child.san)).toEqual(["d4", "Nf3"]);
    unsubscribe();
});

test("closes when adding a legal variation replaces the continuation children", () => {
    const initial = defaultTree();
    initial.root.children = [fixtureNode("e4"), fixtureNode("d4")];
    const tree = createTreeStore(undefined, initial);
    const chooser = createVariationChooserStore();
    const unsubscribe = subscribeVariationChooser(tree, chooser);
    chooser.getState().open(nextContinuation(tree.getState())!.children);
    const choice = chooser.getState().choice;
    const previous = tree.getState();

    tree.getState().makeMove({ payload: "c4", changePosition: false, changeHeaders: false });

    expect(tree.getState().root).not.toBe(previous.root);
    for (const field of ["position", "headers", "practicePath"] as const) {
        expect(tree.getState()[field]).toBe(previous[field]);
    }
    const continuation = nextContinuation(tree.getState())!;
    expect(continuation.children).not.toBe(choice?.children);
    expect(continuation.children.map((child) => child.san)).toEqual(["e4", "d4", "c4"]);
    expect(chooser.getState().choice).toBeNull();
    unsubscribe();
});

test("chooser actions are transient and never write to either storage or the tree", () => {
    const tree = createTreeStore("variation-chooser-storage-test");
    const previous = tree.getState();
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const chooser = createVariationChooserStore();
    const unsubscribe = subscribeVariationChooser(tree, chooser);
    try {
        chooser.getState().open([fixtureNode("e4"), fixtureNode("d4")]);
        chooser.getState().select(-1);
        expect(chooser.getState().choice?.selected).toBe(1);
        chooser.getState().selectIndex(0);
        chooser.getState().close();
        expect(storageWrite).not.toHaveBeenCalled();
        expect(tree.getState()).toBe(previous);
        expect(tree.getState()).not.toHaveProperty("choice");
    } finally {
        unsubscribe();
        storageWrite.mockRestore();
        closeTreeStore("variation-chooser-storage-test");
    }
});
