import { CoachText } from "@/components/panels/coach/CoachText";
import { AssistantTargetLink } from "../AssistantTargetLink";
import type { AssistantTargetActions, AssistantTargetEntry } from "../targets";
import { parseGuideBlocks, parseGuideInline } from "./guideBody";
import classes from "./GuidePage.module.css";

function InlineContent({
  text,
  targets,
  fallbackTargets,
  targetActions,
}: {
  text: string;
  targets: ReadonlyMap<string, AssistantTargetEntry>;
  fallbackTargets: ReadonlyMap<string, AssistantTargetEntry>;
  targetActions: AssistantTargetActions;
}) {
  const segments = parseGuideInline(text, targets, fallbackTargets);
  return (
    <>
      {segments.map((segment, index) => {
        switch (segment.kind) {
          case "link":
            return (
              <AssistantTargetLink key={index} entry={segment.entry} actions={targetActions} />
            );
          case "plain":
            return <span key={index}>{segment.text}</span>;
          case "code":
            return (
              <code key={index} className={classes.inlineCode}>
                {segment.text}
              </code>
            );
          case "text":
            return <CoachText key={index} text={segment.text} />;
        }
      })}
    </>
  );
}

/**
 * Text-only renderer for a resolved help topic body. Renders paragraphs, unordered lists,
 * ordered lists, inline code, emphasis via `CoachText`, and links via `AssistantTargetLink`.
 */
export function GuideTopicBody({
  body,
  targets,
  fallbackTargets,
  targetActions,
}: {
  body: string;
  targets: ReadonlyMap<string, AssistantTargetEntry>;
  fallbackTargets: ReadonlyMap<string, AssistantTargetEntry>;
  targetActions: AssistantTargetActions;
}) {
  const blocks = parseGuideBlocks(body);
  return (
    <div className={classes.topicBody}>
      {blocks.map((block, index) => {
        if (block.kind === "paragraph") {
          return (
            <p key={index} className={classes.paragraph}>
              <InlineContent
                text={block.text}
                targets={targets}
                fallbackTargets={fallbackTargets}
                targetActions={targetActions}
              />
            </p>
          );
        }
        const ListTag = block.kind === "ordered-list" ? "ol" : "ul";
        return (
          <ListTag key={index} className={classes.list}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} className={classes.listItem}>
                <InlineContent
                  text={item}
                  targets={targets}
                  fallbackTargets={fallbackTargets}
                  targetActions={targetActions}
                />
              </li>
            ))}
          </ListTag>
        );
      })}
    </div>
  );
}
