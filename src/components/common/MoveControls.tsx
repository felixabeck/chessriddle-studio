import { Group } from "@mantine/core";
import { ChevronLeft, ChevronRight, ChevronFirst, ChevronLast } from "lucide-react";
import { useAtomValue } from "jotai";
import { memo, useContext, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { chooseVariationAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybinds";
import { nextContinuation } from "@/state/store/tree";
import { isEngineLinePreviewOpen, isHotkeySuppressed } from "@/utils/keyboardOwnership";
import {
  TreeStateContext,
  useGoToNextOpenVariation,
  useVariationChooser,
} from "@/components/common/TreeStateContext";
import IconAction from "./IconAction";
import { releaseFocusOnMoveKey } from "./MoveCell";
import { MoveDeletionContext } from "./MoveDeletionContext";

function isBareVerticalArrow(event: KeyboardEvent) {
  return (
    (event.key === "ArrowUp" || event.key === "ArrowDown") &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  );
}

function MoveControls({ readOnly }: { readOnly?: boolean }) {
  const groupRef = useRef<HTMLDivElement>(null);
  const store = useContext(TreeStateContext)!;
  const { t } = useTranslation();
  const goToNext = useStore(store, (s) => s.goToNext);
  const goToContinuation = useStore(store, (s) => s.goToContinuation);
  const goToPrevious = useStore(store, (s) => s.goToPrevious);
  const start = useStore(store, (s) => s.goToStart);
  const end = useStore(store, (s) => s.goToEnd);
  const deleteMove = useStore(store, (s) => s.deleteMove);
  const deleteVariation = useStore(store, (s) => s.deleteVariation);
  const deleteMovesAfter = useStore(store, (s) => s.deleteMovesAfter);
  const promoteVariation = useStore(store, (s) => s.promoteVariation);
  const deletion = useContext(MoveDeletionContext);
  const startBranch = useStore(store, (s) => s.goToBranchStart);
  const endBranch = useStore(store, (s) => s.goToBranchEndOrNextLine);
  const nextBranch = useStore(store, (s) => s.nextBranch);
  const previousBranch = useStore(store, (s) => s.previousBranch);
  const nextBranching = useStore(store, (s) => s.nextBranching);
  const previousBranching = useStore(store, (s) => s.previousBranching);
  const goToNextOpenVariation = useGoToNextOpenVariation(store);
  const chooseVariation = useAtomValue(chooseVariationAtom);

  const { choice, open, select, close } = useVariationChooser();

  const navigate = (action: () => void) => () => {
    close();
    action();
  };
  const branchNavigation = (action: () => void) => (event: KeyboardEvent) => {
    if (choice && isBareVerticalArrow(event)) return;
    releaseFocusOnMoveKey(event);
    navigate(action)();
  };

  const next = () => {
    if (choice) {
      close();
      goToContinuation(choice.selected);
    } else {
      const state = store.getState();
      const c = nextContinuation(state);
      if (chooseVariation && state.practicePath === null && c && c.children.length > 1) {
        open(c.children);
      } else {
        goToNext();
      }
    }
  };
  const previous = () => (choice ? close() : goToPrevious());

  const shortcutOptions = (enabled = true) => ({
    enabled,
    // ignoreEventWhen runs before preventDefault/enabled, so suspended keys neither fire
    // nor prevent default or stop propagation inside the owning dialog, and keys a slider
    // or the board grid handles itself stay with that widget.
    ignoreEventWhen: (event: KeyboardEvent) => isHotkeySuppressed(event, groupRef.current),
  });

  const moveKey = (action: (event: KeyboardEvent) => void) => (event: KeyboardEvent) => {
    releaseFocusOnMoveKey(event);
    action(event);
  };

  const keyMap = useAtomValue(keyMapAtom);
  // An open engine-line preview board steps through its line with these keys instead.
  const stepOptions = {
    ...shortcutOptions(),
    ignoreEventWhen: (event: KeyboardEvent) =>
      isEngineLinePreviewOpen() || isHotkeySuppressed(event, groupRef.current),
  };
  useHotkeys(keyMap.PREVIOUS_MOVE.keys, moveKey(previous), stepOptions);
  useHotkeys(keyMap.NEXT_MOVE.keys, moveKey(next), stepOptions);
  useHotkeys(keyMap.GO_TO_START.keys, moveKey(navigate(start)), shortcutOptions());
  useHotkeys(keyMap.GO_TO_END.keys, moveKey(navigate(end)), shortcutOptions());
  useHotkeys(
    keyMap.DELETE_MOVE.keys,
    navigate(() => {
      if (readOnly) return;
      if (deletion) deletion.delete(store.getState().position);
      else deleteMove();
    }),
    shortcutOptions(),
  );
  // A live game provides `deletion`: its tree mirrors the native game, so these edits stay off,
  // and a disabled key keeps its default action.
  const lineEditOptions = shortcutOptions(!readOnly && !deletion);
  const editCurrentLine = (edit: (path: number[]) => void) =>
    navigate(() => edit(store.getState().position));
  useHotkeys(keyMap.DELETE_VARIATION.keys, editCurrentLine(deleteVariation), lineEditOptions);
  useHotkeys(keyMap.DELETE_MOVES_AFTER.keys, editCurrentLine(deleteMovesAfter), lineEditOptions);
  // preventDefault: the modified arrow must not also scroll the notation.
  useHotkeys(keyMap.PROMOTE_VARIATION.keys, editCurrentLine(promoteVariation), {
    ...lineEditOptions,
    preventDefault: true,
  });
  // While the list is open, only bare ArrowUp/ArrowDown select, whatever the branch key bindings.
  // preventDefault: a no-op press at the main line end must not scroll the notation instead.
  useHotkeys(keyMap.GO_TO_BRANCH_START.keys, branchNavigation(startBranch), {
    ...shortcutOptions(),
    preventDefault: true,
  });
  useHotkeys(keyMap.GO_TO_BRANCH_END.keys, branchNavigation(endBranch), {
    ...shortcutOptions(),
    preventDefault: true,
  });
  useHotkeys("arrowup", () => select(-1), {
    ...shortcutOptions(choice !== null),
    preventDefault: true,
  });
  useHotkeys("arrowdown", () => select(1), {
    ...shortcutOptions(choice !== null),
    preventDefault: true,
  });
  useHotkeys("escape", () => close(), shortcutOptions(choice !== null));
  useHotkeys(keyMap.NEXT_BRANCH.keys, moveKey(navigate(nextBranch)), shortcutOptions());
  useHotkeys(keyMap.PREVIOUS_BRANCH.keys, moveKey(navigate(previousBranch)), shortcutOptions());
  useHotkeys(keyMap.NEXT_BRANCHING.keys, moveKey(navigate(nextBranching)), shortcutOptions());
  useHotkeys(
    keyMap.PREVIOUS_BRANCHING.keys,
    moveKey(navigate(previousBranching)),
    shortcutOptions(),
  );
  useHotkeys(
    keyMap.NEXT_OPEN_VARIATION.keys,
    moveKey(navigate(goToNextOpenVariation)),
    shortcutOptions(),
  );

  return (
    <Group ref={groupRef} grow gap="xs">
      <IconAction
        label={t("Common.MoveControls.GoToStart", { defaultValue: "Go to start" })}
        variant="default"
        size="lg"
        onClick={navigate(start)}
      >
        <ChevronFirst />
      </IconAction>
      <IconAction
        label={t("Common.MoveControls.Previous", { defaultValue: "Previous move" })}
        variant="default"
        size="lg"
        onClick={previous}
      >
        <ChevronLeft />
      </IconAction>
      <IconAction
        label={t("Common.MoveControls.Next", { defaultValue: "Next move" })}
        variant="default"
        size="lg"
        onClick={next}
      >
        <ChevronRight />
      </IconAction>
      <IconAction
        label={t("Common.MoveControls.GoToEnd", { defaultValue: "Go to end" })}
        variant="default"
        size="lg"
        onClick={navigate(end)}
      >
        <ChevronLast />
      </IconAction>
    </Group>
  );
}

export default memo(MoveControls);
