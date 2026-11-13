import type { Color } from "@lichess-org/chessground/types";
import { FocusTrap, SimpleGrid } from "@mantine/core";
import { useClickOutside } from "@mantine/hooks";
import type { NormalMove, Role } from "chessops";
import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { squareToCoordinates } from "@/utils/chessops";
import IconAction from "../common/IconAction";
import Piece from "../common/Piece";

const promotionPieces: Role[] = ["queen", "knight", "rook", "bishop"];

const PromotionModal = memo(function PromotionModal({
  pendingMove,
  cancelMove,
  confirmMove,
  turn,
  orientation,
}: {
  pendingMove: NormalMove | null;
  cancelMove: () => void;
  confirmMove: (p: Role) => void;
  turn: Color;
  orientation: Color;
}) {
  const { t } = useTranslation();
  const ref = useClickOutside(() => cancelMove());
  const firstChoiceRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!pendingMove) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstChoiceRef.current?.focus();
    return () => previousFocusRef.current?.focus();
  }, [pendingMove]);

  if (!pendingMove) {
    return null;
  }
  const { file, rank } = squareToCoordinates(pendingMove.to, orientation);
  const displayPieces = turn !== orientation ? [...promotionPieces].reverse() : promotionPieces;
  const pieceLabels: Record<Role, string> = {
    king: t("Board.Promotion.King", { defaultValue: "king" }),
    queen: t("Board.Promotion.Queen", { defaultValue: "queen" }),
    rook: t("Board.Promotion.Rook", { defaultValue: "rook" }),
    bishop: t("Board.Promotion.Bishop", { defaultValue: "bishop" }),
    knight: t("Board.Promotion.Knight", { defaultValue: "knight" }),
    pawn: t("Board.Promotion.Pawn", { defaultValue: "pawn" }),
  };
  return (
    <>
      {pendingMove && (
        <>
          <div
            style={{
              position: "absolute",
              zIndex: 100,
              width: "100%",
              height: "100%",
              background: "rgba(0,0,0,0.5)",
            }}
          />
          <FocusTrap active>
            <div
              ref={ref}
              role="dialog"
              aria-modal="true"
              aria-label={t("Board.Promotion.DialogLabel", {
                defaultValue: "Choose promotion piece",
              })}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelMove();
                }
                const index = Number.parseInt(event.key, 10) - 1;
                if (index >= 0 && index < promotionPieces.length) {
                  event.preventDefault();
                  confirmMove(promotionPieces[index]);
                }
              }}
              style={{
                position: "absolute",
                zIndex: 100,
                width: "12.5%",
                height: "50%",
                left: `${(file - 1) * 12.5}%`,
                top: rank === 1 ? "50%" : "0%",
                background: "rgba(255,255,255,0.8)",
              }}
            >
              <SimpleGrid cols={1} spacing={0} verticalSpacing={0} h="100%">
                {displayPieces.map((p) => (
                  <IconAction
                    key={p}
                    ref={p === "queen" ? firstChoiceRef : undefined}
                    label={t("Board.Promotion.Choose", {
                      defaultValue: "Promote to {{piece}}",
                      piece: pieceLabels[p],
                    })}
                    w="100%"
                    h="100%"
                    onClick={() => {
                      confirmMove(p);
                    }}
                  >
                    <Piece
                      piece={{
                        role: p,
                        color: turn,
                      }}
                    />
                  </IconAction>
                ))}
              </SimpleGrid>
            </div>
          </FocusTrap>
        </>
      )}
    </>
  );
});

export default PromotionModal;
