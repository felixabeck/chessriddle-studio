import { File } from "lucide-react";
import {
  RepertoireIcon,
  GameIcon,
  TournamentIcon,
  PuzzlesIcon,
} from "@/components/common/iconCatalog";
import type { FileType } from "./file";

function getFileIcon(type: FileType) {
  switch (type) {
    case "repertoire":
      return RepertoireIcon;
    case "game":
      return GameIcon;
    case "tournament":
      return TournamentIcon;
    case "puzzle":
      return PuzzlesIcon;
    default:
      return File;
  }
}

export function FileIcon({ type, ...props }: { type: FileType } & any) {
  const Icon = getFileIcon(type);
  return <Icon {...props} />;
}
