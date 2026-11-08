import type { TFunction } from "i18next";

export type EngineOptionPresentation = {
    tier: "essential" | "expert";
    label: string;
    description?: string;
};

export function getEngineOptionPresentation(name: string, t: TFunction): EngineOptionPresentation {
    switch (name.toLowerCase()) {
        case "threads":
            return {
                tier: "essential",
                label: t("Engines.Options.Threads.Label"),
                description: t("Engines.Options.Threads.Description"),
            };
        case "hash":
            return {
                tier: "essential",
                label: t("Engines.Options.Hash.Label"),
                description: t("Engines.Options.Hash.Description"),
            };
        case "multipv":
            return {
                tier: "essential",
                label: t("Engines.Options.MultiPV.Label"),
                description: t("Engines.Options.MultiPV.Description"),
            };
        case "uci_showwdl":
            return {
                tier: "essential",
                label: t("Engines.Options.UCI_ShowWDL.Label"),
                description: t("Engines.Options.UCI_ShowWDL.Description"),
            };
        case "syzygypath":
            return {
                tier: "expert",
                label: t("Engines.Options.SyzygyPath.Label"),
                description: t("Engines.Options.SyzygyPath.Description"),
            };
        case "syzygyprobedepth":
            return {
                tier: "expert",
                label: t("Engines.Options.SyzygyProbeDepth.Label"),
                description: t("Engines.Options.SyzygyProbeDepth.Description"),
            };
        case "syzygyprobelimit":
            return {
                tier: "expert",
                label: t("Engines.Options.SyzygyProbeLimit.Label"),
                description: t("Engines.Options.SyzygyProbeLimit.Description"),
            };
        case "syzygy50moverule":
            return {
                tier: "expert",
                label: t("Engines.Options.Syzygy50MoveRule.Label"),
                description: t("Engines.Options.Syzygy50MoveRule.Description"),
            };
        case "evalfile":
            return {
                tier: "expert",
                label: t("Engines.Options.EvalFile.Label"),
                description: t("Engines.Options.EvalFile.Description"),
            };
        case "evalfilesmall":
            return {
                tier: "expert",
                label: t("Engines.Options.EvalFileSmall.Label"),
                description: t("Engines.Options.EvalFileSmall.Description"),
            };
        case "skill level":
            return {
                tier: "expert",
                label: t("Engines.Options.SkillLevel.Label"),
                description: t("Engines.Options.SkillLevel.Description"),
            };
        case "uci_limitstrength":
            return {
                tier: "expert",
                label: t("Engines.Options.UCI_LimitStrength.Label"),
                description: t("Engines.Options.UCI_LimitStrength.Description"),
            };
        case "uci_elo":
            return {
                tier: "expert",
                label: t("Engines.Options.UCI_Elo.Label"),
                description: t("Engines.Options.UCI_Elo.Description"),
            };
        case "ponder":
            return {
                tier: "expert",
                label: t("Engines.Options.Ponder.Label"),
                description: t("Engines.Options.Ponder.Description"),
            };
        case "move overhead":
            return {
                tier: "expert",
                label: t("Engines.Options.MoveOverhead.Label"),
                description: t("Engines.Options.MoveOverhead.Description"),
            };
        case "nodestime":
            return {
                tier: "expert",
                label: t("Engines.Options.nodestime.Label"),
                description: t("Engines.Options.nodestime.Description"),
            };
        case "numapolicy":
            return {
                tier: "expert",
                label: t("Engines.Options.NumaPolicy.Label"),
                description: t("Engines.Options.NumaPolicy.Description"),
            };
        case "uci_chess960":
            return {
                tier: "expert",
                label: t("Engines.Options.UCI_Chess960.Label"),
                description: t("Engines.Options.UCI_Chess960.Description"),
            };
        case "debug log file":
            return {
                tier: "expert",
                label: t("Engines.Options.DebugLogFile.Label"),
                description: t("Engines.Options.DebugLogFile.Description"),
            };
        default:
            return { tier: "essential", label: name };
    }
}
