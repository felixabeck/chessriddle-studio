import { Chessground as NativeChessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { Config } from "@lichess-org/chessground/config";
import type { Key } from "@lichess-org/chessground/types";
import { Box } from "@mantine/core";
import equal from "fast-deep-equal";
import { useAtomValue } from "jotai";
import { type Ref, type RefObject, useEffect, useImperativeHandle, useRef } from "react";
import {
  BOARD_ANIMATION_DURATION_MS,
  boardAnimationSpeedAtom,
  boardImageAtom,
  boardWoodTextureAtom,
  moveMethodAtom,
} from "@/state/atoms";
import { pgnDrawingBrushes } from "@/utils/drawings";

const BOARD_COORDINATE_COLORS: Record<string, { white: string; black: string }> = {
  chessriddle: { white: "#e8ceab", black: "#bc7944" },
  blue: { white: "#dee3e6", black: "#788a94" },
  blue2: { white: "#97b2c7", black: "#546f82" },
  blue3: { white: "#d9e0e6", black: "#315991" },
  "blue-marble": { white: "#eae6dd", black: "#7c7f87" },
  canvas2: { white: "#d7daeb", black: "#547388" },
  wood: { white: "#d8a45b", black: "#9b4d0f" },
  wood2: { white: "#a38b5d", black: "#6c5017" },
  wood3: { white: "#d0ceca", black: "#755839" },
  wood4: { white: "#caaf7d", black: "#7b5330" },
  maple: { white: "#e8ceab", black: "#bc7944" },
  maple2: { white: "#e2c89f", black: "#963" },
  leather: { white: "#d1d1c9", black: "#c28e16" },
  green: { white: "#ffd", black: "#6d8753" },
  brown: { white: "#f0d9b5", black: "#946f51" },
  "pink-pyramid": { white: "#e8e9b7", black: "#ed7272" },
  marble: { white: "#93ab91", black: "#4f644e" },
  "green-plastic": { white: "#f2f9bb", black: "#59935d" },
  grey: { white: "#b8b8b8", black: "#7d7d7d" },
  metal: { white: "#c9c9c9", black: "#727272" },
  olive: { white: "#b8b19f", black: "#6d6655" },
  newspaper: { white: "#fff", black: "#8d8d8d" },
  purple: { white: "#9f90b0", black: "#7d4a8d" },
  "purple-diag": { white: "#e5daf0", black: "#957ab0" },
  ic: { white: "#ececec", black: "#c1c18e" },
  horsey: { white: "#f0d9b5", black: "#946f51" },
  gray: { white: "#e9ecef", black: "#868e96" },
};

function getBoardCoordinateColors(boardImage: string): {
  white: string;
  black: string;
} {
  const boardKey = boardImage.replace(/\.[^/.]+$/, "");
  return (
    BOARD_COORDINATE_COLORS[boardKey] ?? {
      white: "rgba(255, 255, 255, 0.8)",
      black: "rgba(72, 72, 72, 0.8)",
    }
  );
}

export interface ChessgroundRef {
  playPremove: () => boolean;
  cancelPremove: () => void;
  queuePremove: (from: Key, to: Key) => boolean;
}

interface ChessgroundProps extends Config {
  setBoardFen?: (fen: string) => void;
  ref?: Ref<ChessgroundRef>;
}

function configForBounds(config: Config, { width, height }: DOMRect): Config {
  const visible = width > 0 && height > 0;
  return {
    ...config,
    drawable: {
      ...config.drawable,
      ...(config.drawable?.shapes && {
        shapes: visible
          ? config.drawable.shapes.map((shape) =>
              shape.dest === shape.orig ? { ...shape, dest: undefined } : shape,
            )
          : [],
      }),
      ...(!visible && { autoShapes: [] }),
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type ConfigCallback = (...args: unknown[]) => unknown;

// Chessground retains callbacks when merging config. Stable trampolines read only committed
// closures, including when an otherwise identical render does not need api.set.
function withTrampolines(
  config: Config,
  appliedConfigRef: RefObject<Config>,
  callbacks: Map<string, ConfigCallback>,
): Config {
  function copy(value: unknown, path: string): unknown {
    if (typeof value === "function") {
      let callback = callbacks.get(path);
      if (!callback) {
        callback = (...args) => {
          let current: unknown = appliedConfigRef.current;
          for (const key of path.split(".")) {
            current = isPlainObject(current) ? current[key] : undefined;
          }
          return (current as ConfigCallback | undefined)?.(...args);
        };
        callbacks.set(path, callback);
      }
      return callback;
    }
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        copy(child, path ? `${path}.${key}` : key),
      ]),
    );
  }
  return copy(config, "") as Config;
}

function snapshot(value: unknown): unknown {
  if (typeof value === "function") return "__fn__";
  if (Array.isArray(value)) return value.map(snapshot);
  if (value instanceof Map) return [...value].map(([key, child]) => [key, snapshot(child)]);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, snapshot(child)]));
  }
  return value;
}

export function Chessground({ ref, ...props }: ChessgroundProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);

  const moveMethod = useAtomValue(moveMethodAtom);
  const animationSpeed = useAtomValue(boardAnimationSpeedAtom);
  const configRef = useRef<Config>(props);
  const appliedConfigRef = useRef<Config>(configRef.current);
  const callbacksRef = useRef(new Map<string, ConfigCallback>());
  const lastAppliedRef = useRef<unknown>(null);
  const divergedRef = useRef(false);
  configRef.current = {
    ...props,
    drawable: {
      ...props.drawable,
      // Every board must know every colour the drawing modifiers can produce.
      brushes: { ...props.drawable?.brushes, ...pgnDrawingBrushes },
      onChange: (shapes) => {
        divergedRef.current = true;
        const api = apiRef.current;
        // Chessground clears on empty/opponent-square clicks even when its
        // eraseOnMovablePieceClick is false. Keep the explicit user preference.
        // Drawing changes run while drawable.current still identifies the gesture.
        if (
          props.drawable?.eraseOnMovablePieceClick === false &&
          props.drawable.shapes &&
          api &&
          !api.state.drawable.current
        ) {
          const element = boardRef.current;
          if (element) {
            api.setShapes(
              configForBounds(props, element.getBoundingClientRect()).drawable?.shapes ?? [],
            );
          }
          return;
        }
        props.drawable?.onChange?.(shapes);
      },
    },
    events: {
      ...props.events,
      change: () => {
        divergedRef.current = true;
        const api = apiRef.current;
        if (props.setBoardFen && api) props.setBoardFen(api.getFen());
      },
    },
    draggable: {
      ...props.draggable,
      enabled: moveMethod !== "select",
    },
    selectable: {
      ...props.selectable,
      enabled: moveMethod !== "drag",
    },
    // Chessground merges config into its state, so `enabled` is always sent explicitly: a board
    // that was switched off must turn back on, unless the caller disables animation itself.
    animation:
      animationSpeed === "off"
        ? { ...props.animation, enabled: false }
        : {
            ...props.animation,
            enabled: props.animation?.enabled !== false,
            duration: BOARD_ANIMATION_DURATION_MS[animationSpeed],
          },
  };

  useImperativeHandle(
    ref,
    () => ({
      playPremove: () => apiRef.current?.playPremove() ?? false,
      cancelPremove: () => apiRef.current?.cancelPremove(),
      queuePremove: (from, to) => {
        const api = apiRef.current;
        if (!api) return false;
        api.selectSquare(from);
        api.selectSquare(to);
        return api.state.premovable.current !== undefined;
      },
    }),
    [],
  );

  useEffect(() => {
    const element = boardRef.current;
    if (element == null) return;
    let { width, height } = element.getBoundingClientRect();
    appliedConfigRef.current = configRef.current;
    const initial = {
      ...configForBounds(
        withTrampolines(configRef.current, appliedConfigRef, callbacksRef.current),
        element.getBoundingClientRect(),
      ),
      addDimensionsCssVarsTo: element,
    };
    // configure mutates movable.dests, so capture the authoritative input before handing it over.
    lastAppliedRef.current = snapshot(initial);
    const chessgroundApi = NativeChessground(element, initial);
    apiRef.current = chessgroundApi;
    const observer = new ResizeObserver(() => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width === width && bounds.height === height) return;
      width = bounds.width;
      height = bounds.height;
      if (width > 0 && height > 0) {
        chessgroundApi.state.dom.bounds.clear();
        // A 0×0 box paints squares as lines with NaN coordinates.
        // Restore both layers without reapplying fen or changing the position.
        const shapes = configForBounds(configRef.current, bounds).drawable?.shapes;
        if (shapes) chessgroundApi.setShapes(shapes);
        chessgroundApi.setAutoShapes(configRef.current.drawable?.autoShapes ?? []);
      }
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      chessgroundApi.destroy();
      apiRef.current = null;
    };
    // Chessground owns the element for this whole mount. Configuration is applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    appliedConfigRef.current = configRef.current;
    const api = apiRef.current;
    const element = boardRef.current;
    if (!api || !element) return;
    const bounds = element.getBoundingClientRect();
    const next = configForBounds(
      withTrampolines(configRef.current, appliedConfigRef, callbacksRef.current),
      bounds,
    );
    const snap = snapshot(next);
    if (
      !divergedRef.current &&
      lastAppliedRef.current !== null &&
      equal(snap, lastAppliedRef.current)
    )
      return;
    // Clock ticks and identical engine arrows need no reset. User changes still require the
    // authoritative config to be reapplied, even when its values have not changed.
    // The bounds cache still holds the 0×0 box measured at creation until it is cleared. Only a
    // positive size may clear it: a hidden board must not re-cache a 0×0 box.
    if (bounds.width > 0 && bounds.height > 0) api.state.dom.bounds.clear();
    api.set(next);
    lastAppliedRef.current = snap;
    divergedRef.current = false;
  }, [props, moveMethod, animationSpeed]);

  const boardImage = useAtomValue(boardImageAtom);
  const woodTexture = useAtomValue(boardWoodTextureAtom);
  const boardCoordColors = getBoardCoordinateColors(boardImage);

  return (
    <Box
      style={{
        aspectRatio: 1,
        width: "100%",
        "--board-image": `url('/board/${boardImage}')`,
        "--board-texture": woodTexture ? "url('/board/wood4-square.png')" : "none",
        "--board-coord-color-white": boardCoordColors.white,
        "--board-coord-color-black": boardCoordColors.black,
      }}
      ref={boardRef}
    />
  );
}
