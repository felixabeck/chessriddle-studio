import { useOwnerTabId, useTabAtom } from "@/state/tabScope";
import { Box, Button, Checkbox, Group, rem, Stack, Text, Textarea } from "@mantine/core";
import { Check, Copy } from "lucide-react";
import deepEqual from "fast-deep-equal";
import { useAtom } from "jotai";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useClipboardCopy } from "@/hooks/useClipboardCopy";
import { useStore } from "zustand";
import { isTreeViewDeferred, useTreeView } from "@/state/deferredTreeView";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { IconAction } from "@/components/common/IconAction";
import { closingTabsAtom, pgnOptionsFamily, tabsAtom } from "@/state/atoms";
import { getCachedTreeStore, type TreeStore } from "@/state/store/tree";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { getPGN, parsePGN } from "@/utils/chess";
import { sameTabOwner, useTabActions } from "@/utils/tabs";

// Accepted edits belong to the cached document across panel remounts. One pending edit per
// store is retired by newer intent or document changes, and releases every subscription.
const pendingPgnEdits = new WeakMap<TreeStore, { retire: () => void }>();

function PgnInput() {
  const store = useContext(TreeStateContext)!;
  const tabId = useOwnerTabId();
  const { workspace, getTab } = useTabActions();
  const mounted = useRef(false);
  const { root, headers } = useTreeView(store);
  const setState = useStore(store, (s) => s.setState);
  const [options, setOptions] = useAtom(useTabAtom(pgnOptionsFamily));
  const { t } = useTranslation();
  const { copied, copy } = useClipboardCopy(t("Board.CopyFailed"));

  const realPGN = useMemo(() => {
    if (isTreeViewDeferred(store)) return "";
    return getPGN(root, {
      headers: headers,
      glyphs: true,
      comments: true,
      variations: true,
      extraMarkups: true,
    });
  }, [root, headers, store]);

  const pgn = useMemo(() => {
    if (isTreeViewDeferred(store)) return "";
    return getPGN(root, {
      headers: headers,
      glyphs: options.glyphs,
      comments: options.comments,
      variations: options.variations,
      extraMarkups: options.extraMarkups,
    });
  }, [root, headers, options, store]);

  const [editor, setEditor] = useState({ text: pgn, root });
  const tmp = editor.text;
  const setTmp = (text: string) => setEditor({ text, root });
  const serializedPgn = useRef(pgn);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    // Root identity changes when analysis stores a score. The serialized PGN often
    // does not. Only a new serialization replaces the draft; the editor still follows
    // the root that produced the text the user is looking at.
    const serializedChanged = !Object.is(serializedPgn.current, pgn);
    serializedPgn.current = pgn;
    setEditor((current) => {
      const text = serializedChanged ? pgn : current.text;
      if (current.text === text && current.root === root) return current;
      return { text, root };
    });
  }, [pgn, root]);

  const controls = (
    <>
      <Text component="label" htmlFor="pgn-editor" fw="bold">
        {t("PgnInput.Editor", { defaultValue: "PGN editor" })}
      </Text>
      <Group my="sm">
        <Checkbox
          label={t("PgnInput.Comments")}
          size="xs"
          checked={options.comments}
          onChange={() => setOptions({ ...options, comments: !options.comments })}
        />
        <Checkbox
          label={t("PgnInput.Glyphs")}
          size="xs"
          checked={options.glyphs}
          onChange={() => setOptions({ ...options, glyphs: !options.glyphs })}
        />
        <Checkbox
          label={t("PgnInput.Variations")}
          size="xs"
          checked={options.variations}
          onChange={() => setOptions({ ...options, variations: !options.variations })}
        />
        <Checkbox
          label={t("PgnInput.ExtraMarkups")}
          size="xs"
          checked={options.extraMarkups}
          onChange={() => setOptions({ ...options, extraMarkups: !options.extraMarkups })}
        />
      </Group>
    </>
  );

  async function updatePgn() {
    if (root !== store.getState().root || editor.root !== store.getState().root) return;
    const owner = getTab(tabId);
    if (!owner || getCachedTreeStore(tabId) !== store || workspace.get(closingTabsAtom).has(tabId))
      return;
    pendingPgnEdits.get(store)?.retire();
    const captured = store.getState();
    const source = {
      linkedSource: captured.linkedSource,
      sourceStamp: captured.sourceStamp,
      appendAttempted: captured.appendAttempted,
    };
    const controller = new AbortController();
    const subscriptions: Array<() => void> = [];
    const operation = {
      retire: () => {
        if (pendingPgnEdits.get(store) === operation) pendingPgnEdits.delete(store);
        for (const stop of subscriptions.splice(0)) stop();
        controller.abort();
      },
    };
    const isCurrent = () => {
      const current = getTab(tabId);
      const live = store.getState();
      return (
        pendingPgnEdits.get(store) === operation &&
        !controller.signal.aborted &&
        sameTabOwner(current, owner) &&
        deepEqual(current.gameOrigin, owner.gameOrigin) &&
        !workspace.get(closingTabsAtom).has(tabId) &&
        getCachedTreeStore(tabId) === store &&
        live.root === captured.root &&
        live.headers === captured.headers &&
        live.sourceStamp === source.sourceStamp &&
        live.linkedSource === source.linkedSource &&
        live.appendAttempted === source.appendAttempted
      );
    };
    const retireChangedDocument = () => {
      if (!isCurrent()) operation.retire();
    };
    pendingPgnEdits.set(store, operation);
    try {
      subscriptions.push(store.subscribe(retireChangedDocument));
      subscriptions.push(workspace.sub(tabsAtom, retireChangedDocument));
      subscriptions.push(workspace.sub(closingTabsAtom, retireChangedDocument));
      if (!isCurrent()) return;
      const tree = await parsePGN(tmp, undefined, { signal: controller.signal });
      if (!isCurrent()) return;
      // Release before publishing so our own accepted edit cannot retire its operation.
      operation.retire();
      if (deepEqual(tree.root, captured.root) && deepEqual(tree.headers, captured.headers)) {
        if (mounted.current) setTmp(pgn);
      } else {
        setState({
          ...tree,
          linkedSource: source.linkedSource,
          sourceStamp: source.sourceStamp,
          appendAttempted: source.appendAttempted,
          dirty: true,
          position: [],
        });
      }
    } catch (error) {
      if (isCurrent()) notifyUnlessCancelled(t("Common.Error"), error);
    } finally {
      operation.retire();
    }
  }

  const pgnArea = (
    <Box style={{ position: "relative" }}>
      <Textarea
        id="pgn-editor"
        aria-label={t("Common.PGNGame")}
        autosize
        value={tmp}
        onChange={(e) => {
          pendingPgnEdits.get(store)?.retire();
          setTmp(e.currentTarget.value);
        }}
      />
      <IconAction
        label={copied ? t("Common.Copied") : t("Menu.Edit.Copy")}
        color={copied ? "success" : "gray"}
        variant="subtle"
        onClick={() => void copy(tmp)}
        style={{ position: "absolute", top: 15, right: 15 }}
      >
        {copied ? <Check style={{ width: rem(16) }} /> : <Copy style={{ width: rem(16) }} />}
      </IconAction>
      {realPGN !== tmp && (
        <Button style={{ position: "absolute", bottom: 15, right: 15 }} onClick={() => updatePgn()}>
          {t("Common.Update")}
        </Button>
      )}
    </Box>
  );

  return (
    <Stack gap={0}>
      {controls}
      {pgnArea}
    </Stack>
  );
}

export default PgnInput;
