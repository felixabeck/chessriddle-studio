import {
  LibraryDatabaseColumns,
  LibrarySectionHeading,
  LibraryTypeBadge,
  libraryClasses,
} from "@/components/library/presentation";
import { Box, Group, Text } from "@mantine/core";
import { Database, FileText, Folder, FolderOpen, FolderSymlink, Trash2 } from "lucide-react";
import { useAtom } from "jotai";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { IconAction } from "@/components/common/IconAction";
import type { ErrorCategory } from "@/bindings";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { expandedDirectoriesAtom, tabsAtom } from "@/state/atoms";
import { openFile } from "@/utils/files";
import { runTabCreation } from "@/utils/tabs";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import { FILE_TYPES, type Entry, type FileMetadata } from "./file";
import { endRowDragPreview, preloadRowDragImage, startRowDragPreview } from "./rowDragPreview";
import classes from "./DirectoryTree.module.css";

export type CollectionPeer = {
  type: "database";
  section?: "files";
  key: string;
  name: string;
  selected: boolean;
  content: React.ReactNode;
  onSelect?: () => void;
  onOpen?: () => void;
};
type VisibleEntry = { entry: Entry | CollectionPeer; depth: number };
export function childUnreadableMessage(category: ErrorCategory, t: (key: string) => string) {
  switch (category) {
    case "permission":
      return t("Files.ChildUnreadable.Permission");
    case "invalid-input":
    case "parsing":
      return t("Files.ChildUnreadable.Invalid");
    case "resource-limit":
      return t("Files.ChildUnreadable.TooLarge");
    default:
      return t("Files.ChildUnreadable.Title");
  }
}

function entryKey(entry: Entry | CollectionPeer) {
  return entry.type === "database"
    ? `database:${entry.key}`
    : entry.type === "unreadable"
      ? entry.key
      : `${entry.type}:${fileWorkspaceKey(entry.handle)}`;
}

export function filteredTree(files: Entry[], search: string, filter: string): Entry[] {
  const normalizedSearch = search.trim().toLowerCase();
  const visit = (nodes: Entry[]): Entry[] =>
    nodes.reduce<Entry[]>((result, node) => {
      if (node.type === "unreadable") {
        if (!filter && (!normalizedSearch || node.name.toLowerCase().includes(normalizedSearch)))
          result.push(node);
        return result;
      }
      if (node.type === "file") {
        const matchesType = !filter || node.metadata.type === filter;
        const matchesSearch =
          !normalizedSearch || node.name.toLowerCase().includes(normalizedSearch);
        if (matchesType && matchesSearch) result.push(node);
        return result;
      }
      const children = visit(node.children);
      const matchesSearch = !normalizedSearch || node.name.toLowerCase().includes(normalizedSearch);
      if ((!filter && matchesSearch) || children.length) result.push({ ...node, children });
      return result;
    }, []);
  return visit(files);
}
export default function DirectoryTree({
  files,
  selectedFile,
  setSelectedFile,
  onRequestDelete,
  onMove,
  onRequestMove,
  search,
  filter,
  peers = [],
  label,
  onVisibleCount,
  grouped = false,
}: {
  files: Entry[];
  selectedFile: Entry | null;
  setSelectedFile: (file: Entry | null) => void;
  onRequestDelete: (file: Entry) => void | Promise<void>;
  onMove?: (entry: Entry, destination: Entry) => void | Promise<void>;
  onRequestMove?: (entry: Entry) => void;
  search: string;
  filter: string;
  peers?: CollectionPeer[];
  label?: string;
  onVisibleCount?: (count: number) => void;
  grouped?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useAtom(expandedDirectoriesAtom);
  const [, setTabs] = useAtom(tabsAtom);
  const navigate = useNavigate();
  const refs = useRef(new Map<string, HTMLDivElement>());
  const [focusedHandle, setFocusedHandle] = useState<string | null>(null);
  const filtered = useMemo(() => filteredTree(files, search, filter), [files, filter, search]);
  const visible = useMemo(() => {
    const result: VisibleEntry[] = [];
    const visit = (nodes: Entry[], depth: number) =>
      nodes.forEach((node) => {
        result.push({ entry: node, depth });
        if (node.type === "directory" && expanded.includes(fileWorkspaceKey(node.handle)))
          visit(node.children, depth + 1);
      });
    visit(filtered, 0);
    result.push(...peers.map((entry) => ({ entry, depth: 0 })));
    return result;
  }, [expanded, filtered, peers]);
  useEffect(() => {
    preloadRowDragImage();
    return endRowDragPreview;
  }, []);
  const fileCount = visible.filter(
    ({ entry }) => entry.type !== "database" || entry.section === "files",
  ).length;
  useEffect(() => {
    onVisibleCount?.(visible.length);
  }, [visible.length, onVisibleCount]);
  useEffect(() => {
    if (!focusedHandle) return;
    if (!visible.some((item) => entryKey(item.entry) === focusedHandle)) {
      setFocusedHandle(null);
      return;
    }
  }, [focusedHandle, visible]);
  const focusEntry = (entry: VisibleEntry) => {
    const handle = entryKey(entry.entry);
    setFocusedHandle(handle);
    refs.current.get(handle)?.focus();
  };
  const openEntry = (entry: FileMetadata) => {
    void runTabCreation({
      create: () => openFile(entry, setTabs),
      onSuccess: () => navigate({ to: "/" }),
      onError: (error) => notifyUnlessCancelled(t("Common.Error"), error),
    });
  };
  const render = ({ entry: node, depth }: VisibleEntry): React.ReactNode => {
    const isDirectory = node.type === "directory";
    const handleKey = entryKey(node);
    const expansionKey = node.type === "directory" ? fileWorkspaceKey(node.handle) : "";
    const open = expanded.includes(expansionKey);
    return (
      <Box
        key={handleKey}
        role="treeitem"
        className={classes.item}
        aria-label={node.name}
        aria-level={depth + 1}
        aria-selected={
          node.type === "database"
            ? node.selected
            : selectedFile
              ? entryKey(selectedFile) === handleKey
              : false
        }
        aria-expanded={isDirectory ? open : undefined}
        tabIndex={
          focusedHandle === null
            ? visible[0] && entryKey(visible[0].entry) === handleKey
              ? 0
              : -1
            : focusedHandle === handleKey
              ? 0
              : -1
        }
        ref={(element) => {
          if (element) refs.current.set(handleKey, element);
          else refs.current.delete(handleKey);
        }}
        pl={depth * 16}
        onFocus={(event) => {
          if (
            node.type === "database" &&
            event.target instanceof HTMLElement &&
            event.target.matches("button[aria-pressed]")
          )
            event.currentTarget.focus({ preventScroll: true });
          if (event.currentTarget === event.target) setFocusedHandle(handleKey);
        }}
        onKeyDown={(event) => {
          if (event.currentTarget !== event.target) return;
          event.stopPropagation();
          const index = visible.findIndex((item) => entryKey(item.entry) === handleKey);
          const target =
            event.key === "ArrowDown"
              ? visible[index + 1]
              : event.key === "ArrowUp"
                ? visible[index - 1]
                : event.key === "Home"
                  ? visible[0]
                  : event.key === "End"
                    ? visible.at(-1)
                    : event.key === "ArrowRight" && isDirectory && open
                      ? visible[index + 1]?.depth === depth + 1
                        ? visible[index + 1]
                        : undefined
                      : event.key === "ArrowLeft" && !open
                        ? [...visible.slice(0, index)].reverse().find((item) => item.depth < depth)
                        : undefined;
          if (target) {
            event.preventDefault();
            focusEntry(target);
          }
          if (event.key === "ArrowRight" && isDirectory && !open) {
            event.preventDefault();
            setExpanded((old) => [...old, expansionKey]);
          }
          if (event.key === "ArrowLeft" && isDirectory && open) {
            event.preventDefault();
            setExpanded((old) => old.filter((id) => id !== expansionKey));
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (node.type === "database") node.onSelect?.();
            else if (node.type !== "unreadable") setSelectedFile(node);
            if (isDirectory)
              setExpanded((old) =>
                open ? old.filter((id) => id !== expansionKey) : [...old, expansionKey],
              );
            else if (event.key === "Enter") {
              if (node.type === "database") node.onOpen?.();
              else if (node.type === "file") openEntry(node);
            }
          }
          if (
            event.key.toLowerCase() === "m" &&
            node.type !== "database" &&
            node.type !== "unreadable"
          ) {
            event.preventDefault();
            onRequestMove?.(node);
          }
        }}
        onClick={(event) => {
          // The first click of each pair owns selection, even if the second hits another row.
          if (node.type === "file" && event.detail > 0 && event.detail % 2 === 0) return;
          if (node.type === "database") node.onSelect?.();
          else if (node.type !== "unreadable") setSelectedFile(node);
          if (isDirectory)
            setExpanded((old) =>
              open ? old.filter((id) => id !== expansionKey) : [...old, expansionKey],
            );
        }}
        onDoubleClick={() => {
          if (
            node.type === "file" &&
            selectedFile?.type === "file" &&
            entryKey(selectedFile) === handleKey
          )
            openEntry(node);
        }}
        draggable={node.type === "file" || node.type === "directory"}
        onDragStart={(event) => {
          if (node.type === "file" || node.type === "directory") {
            event.dataTransfer.setData(
              "application/x-en-croissant-handle",
              fileWorkspaceKey(node.handle),
            );
            startRowDragPreview(event, classes.tree, classes.dragPreview);
          }
        }}
        onDragOver={(event) => {
          if (isDirectory) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (node.type !== "directory" || !onMove) return;
          const source = visible.find(
            (item) =>
              item.entry.type !== "database" &&
              item.entry.type !== "unreadable" &&
              fileWorkspaceKey(item.entry.handle) ===
                event.dataTransfer.getData("application/x-en-croissant-handle"),
          )?.entry;
          if (
            source &&
            source.type !== "database" &&
            source.type !== "unreadable" &&
            fileWorkspaceKey(source.handle) !== fileWorkspaceKey(node.handle)
          )
            void onMove(source, node);
        }}
      >
        {node.type === "database" ? (
          node.content
        ) : node.type === "unreadable" ? (
          <Group gap="xs" py={4}>
            <Text size="sm" className="wrap-anywhere">
              {node.name}
            </Text>
            <Text size="sm" c="danger" className="wrap-anywhere">
              {childUnreadableMessage(node.category, t)}
            </Text>
          </Group>
        ) : (
          <div className={classes.row}>
            <div className={classes.name}>
              {isDirectory ? (
                open ? (
                  <FolderOpen size={16} />
                ) : (
                  <Folder size={16} />
                )
              ) : (
                <FileText size={16} />
              )}
              <Text size="sm" miw={0} style={{ overflowWrap: "anywhere" }}>
                {node.name}
              </Text>
            </div>
            <div className={classes.metadata}>
              {node.type === "file" && (
                <>
                  <Text size="sm" c="dimmed" className={`${classes.games} wrap-anywhere`}>
                    <span className={classes.inlineLabel}>{t("Databases.Card.Games")} </span>
                    <span>{node.numGames}</span>
                  </Text>
                  <LibraryTypeBadge>
                    {t(
                      FILE_TYPES.find((type) => type.value === node.metadata.type)!.translationKey,
                    )}
                  </LibraryTypeBadge>
                </>
              )}
              {isDirectory && (
                <>
                  <span aria-hidden />
                  <LibraryTypeBadge>
                    {t("Library.Folder", { defaultValue: "Folder" })}
                  </LibraryTypeBadge>
                </>
              )}
            </div>
            <div className={classes.actions}>
              <IconAction
                label={t("Common.Delete")}
                color="danger"
                className={classes.delete}
                variant="subtle"
                size="sm"
                onClick={(event: MouseEvent<HTMLButtonElement>) => {
                  event.stopPropagation();
                  void onRequestDelete(node);
                }}
              >
                <Trash2 size={16} aria-hidden />
              </IconAction>
              <IconAction
                label={t("Files.Move")}
                variant="subtle"
                size="sm"
                onClick={(event: MouseEvent<HTMLButtonElement>) => {
                  event.stopPropagation();
                  onRequestMove?.(node);
                }}
              >
                <FolderSymlink size={16} aria-hidden />
              </IconAction>
            </div>
            {node.type === "file" && node.readError && (
              <Text size="sm" c="danger" className={`${classes.readError} wrap-anywhere`}>
                {childUnreadableMessage(node.readError, t)}
              </Text>
            )}
          </div>
        )}
      </Box>
    );
  };
  return (
    <Box role="tree" aria-label={label ?? t("Files.Title")} className={classes.tree}>
      {grouped && visible.length > 0 ? (
        <>
          <Box role="presentation" className={libraryClasses.section} data-section="files">
            <LibrarySectionHeading count={fileCount} icon={<FileText />}>
              {t("Files.Title", { defaultValue: "Files" })}
            </LibrarySectionHeading>
            {fileCount > 0 && (
              <div
                className={`${classes.row} ${classes.columns} ${libraryClasses.columnCaption}`}
                aria-hidden
                data-library-columns
              >
                <div className={classes.name}>{t("Common.Name")}</div>
                <div className={classes.metadata}>
                  <span>{t("Databases.Card.Games")}</span>
                  <span>{t("Files.FileType")}</span>
                </div>
                <div className={classes.actions} />
              </div>
            )}
            {visible.slice(0, fileCount).map(render)}
          </Box>
          <Box role="presentation" className={libraryClasses.section} data-section="databases">
            <LibrarySectionHeading count={visible.length - fileCount} icon={<Database />}>
              {t("Databases.Title", { defaultValue: "Databases" })}
            </LibrarySectionHeading>
            {visible.length > fileCount && (
              <LibraryDatabaseColumns
                name={t("Common.Name")}
                games={t("Databases.Card.Games")}
                storage={t("Databases.Card.Storage")}
                reference={t("Databases.Settings.ReferenceDatabase")}
              />
            )}
            <div className={classes.databaseList}>{visible.slice(fileCount).map(render)}</div>
          </Box>
        </>
      ) : (
        visible.map(render)
      )}
    </Box>
  );
}
