export const mutationPackages = Object.freeze({
  "annotate-comment": [
    "src/utils/commentSerializer.ts",
    "src/utils/commentNotation.ts",
    "src/components/panels/annotation/AnnotationEditor.tsx",
  ],
  "game-practice": [
    "src/components/boards/gameSession.ts",
    "src/components/panels/practice/session.ts",
  ],
  "workspace-storage": [
    "src/state/workspace.ts",
    "src/state/store/tabStorage.ts",
    "src/state/storageWriteError.ts",
  ],
  "tree-path": ["src/utils/pathCapabilities.ts", "src/utils/treeReducer.ts"],
});
