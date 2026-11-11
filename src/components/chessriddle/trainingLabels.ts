import type { TFunction } from "i18next";
import { formatThemeLabel } from "@/utils/format";
import { DIFFICULTY_GLYPHS } from "./motifCatalog";

export function motifLabel(name: string, t: TFunction): string {
    const labels: Record<string, string> = {
        fork: t("Training.Motif.fork"),
        pin: t("Training.Motif.pin"),
        skewer: t("Training.Motif.skewer"),
        sacrifice: t("Training.Motif.sacrifice"),
        discoveredAttack: t("Training.Motif.discoveredAttack"),
        deflection: t("Training.Motif.deflection"),
        interference: t("Training.Motif.interference"),
        attraction: t("Training.Motif.attraction"),
        hangingPiece: t("Training.Motif.hangingPiece"),
        quietMove: t("Training.Motif.quietMove"),
        doubleBishopMate: t("Training.Motif.doubleBishopMate"),
        doubleCheck: t("Training.Motif.doubleCheck"),
        xRayAttack: t("Training.Motif.xRayAttack"),
        zugzwang: t("Training.Motif.zugzwang"),
        trappedPiece: t("Training.Motif.trappedPiece"),
        clearance: t("Training.Motif.clearance"),
        defensiveMove: t("Training.Motif.defensiveMove"),
        intermezzo: t("Training.Motif.intermezzo"),
        capturingDefender: t("Training.Motif.capturingDefender"),
        attackingF2F7: t("Training.Motif.attackingF2F7"),
        mate: t("Training.Motif.mate"),
        mateIn1: t("Training.Motif.mateIn1"),
        mateIn2: t("Training.Motif.mateIn2"),
        mateIn3: t("Training.Motif.mateIn3"),
        mateIn4: t("Training.Motif.mateIn4"),
        mateIn5: t("Training.Motif.mateIn5"),
        smotheredMate: t("Training.Motif.smotheredMate"),
        backRankMate: t("Training.Motif.backRankMate"),
        bodenMate: t("Training.Motif.bodenMate"),
        hookMate: t("Training.Motif.hookMate"),
        anastasiaMate: t("Training.Motif.anastasiaMate"),
        arabianMate: t("Training.Motif.arabianMate"),
        dovetailMate: t("Training.Motif.dovetailMate"),
        killBoxMate: t("Training.Motif.killBoxMate"),
        vukovicMate: t("Training.Motif.vukovicMate"),
        bishopEndgame: t("Training.Motif.bishopEndgame"),
        knightEndgame: t("Training.Motif.knightEndgame"),
        pawnEndgame: t("Training.Motif.pawnEndgame"),
        rookEndgame: t("Training.Motif.rookEndgame"),
        queenEndgame: t("Training.Motif.queenEndgame"),
        queenRookEndgame: t("Training.Motif.queenRookEndgame"),
        opening: t("Training.Motif.opening"),
        middlegame: t("Training.Motif.middlegame"),
        endgame: t("Training.Motif.endgame"),
        kingsideAttack: t("Training.Motif.kingsideAttack"),
        queensideAttack: t("Training.Motif.queensideAttack"),
        exposedKing: t("Training.Motif.exposedKing"),
        advancedPawn: t("Training.Motif.advancedPawn"),
        promotion: t("Training.Motif.promotion"),
        underPromotion: t("Training.Motif.underPromotion"),
        castling: t("Training.Motif.castling"),
        enPassant: t("Training.Motif.enPassant"),
        short: t("Training.Motif.short"),
        long: t("Training.Motif.long"),
        veryLong: t("Training.Motif.veryLong"),
        oneMove: t("Training.Motif.oneMove"),
        master: t("Training.Motif.master"),
        masterVsMaster: t("Training.Motif.masterVsMaster"),
        superGM: t("Training.Motif.superGM"),
        crushing: t("Training.Motif.crushing"),
        advantage: t("Training.Motif.advantage"),
        equality: t("Training.Motif.equality"),
    };
    return labels[name] ?? formatThemeLabel(name);
}

export function difficultyOptions(t: TFunction) {
    return [
        { value: "-500", label: t("Training.Difficulty.Easiest") },
        { value: "-250", label: t("Training.Difficulty.Easier") },
        { value: "0", label: t("Training.Difficulty.Normal") },
        { value: "250", label: t("Training.Difficulty.Harder") },
        { value: "500", label: t("Training.Difficulty.Hardest") },
    ].map((option, index) => ({ ...option, glyph: DIFFICULTY_GLYPHS[index] }));
}

export function motifCategoryLabels(t: TFunction) {
    return {
        all: t("Training.Settings.Categories.All"),
        tactics: t("Training.Settings.Categories.Tactics"),
        mates: t("Training.Settings.Categories.Mates"),
        endgames: t("Training.Settings.Categories.Endgames"),
        phases: t("Training.Settings.Categories.Phases"),
        position: t("Training.Settings.Categories.Position"),
        other: t("Training.Settings.Categories.Other"),
    };
}
