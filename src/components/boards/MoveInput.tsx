import { Group, Input, Text } from "@mantine/core";
import { isNormal, type NormalMove } from "chessops";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseKeyboardMove } from "@/utils/chess";
import type { TreeNode } from "@/utils/treeReducer";

export default function MoveInput({
  currentNode,
  onMove,
}: {
  currentNode: TreeNode;
  onMove: (move: NormalMove) => boolean;
}) {
  const { t } = useTranslation();
  const [move, setMove] = useState("");
  const [error, setError] = useState("");
  const errorId = useId();

  return (
    <Group gap={6} wrap="nowrap" align="center">
      <Input
        placeholder={t("MoveInput.EnterMove")}
        aria-label={t("MoveInput.EnterMove")}
        aria-describedby={error ? errorId : undefined}
        withAria={false}
        aria-invalid={!!error}
        size="xs"
        onChange={(e) => {
          setMove(e.currentTarget.value);
          setError("");
        }}
        error={error}
        value={move}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const m = move.trim();
            if (m.length > 0) {
              const parsed = parseKeyboardMove(m, currentNode.fen);
              if (parsed && isNormal(parsed) && onMove(parsed)) {
                setMove("");
              } else {
                setError(t("MoveInput.InvalidMove"));
              }
            }
          }
        }}
      />
      {error && (
        <Text id={errorId} size="xs" c="danger" aria-live="polite">
          {error}
        </Text>
      )}
    </Group>
  );
}
