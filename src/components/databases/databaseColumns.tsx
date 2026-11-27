import type { DataTableColumn } from "mantine-datatable";

export const numericColumn = {
  textAlign: "right",
  noWrap: true,
  cellsStyle: () => ({ fontVariantNumeric: "tabular-nums" }),
} satisfies Partial<DataTableColumn<unknown>>;

/**
 * The table's scrollbar is drawn over its content, so the scroll area keeps a strip free for it.
 * The strip is permanent ("y"): Mantine's "present" re-measures only when the viewport is resized,
 * not when rows load into it, and would leave the last column under the scrollbar.
 */
export const tableScrollAreaProps = { offsetScrollbars: "y" } as const;

export const dateColumn = {
  noWrap: true,
} satisfies Partial<DataTableColumn<unknown>>;

export function truncatedTextColumn<T>(value: (record: T) => string | null | undefined) {
  return {
    render: (record: T) => {
      const text = value(record) ?? "";
      return (
        <span
          title={text}
          style={{
            display: "block",
            maxWidth: "16rem",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {text}
        </span>
      );
    },
  } satisfies Partial<DataTableColumn<T>>;
}

export function displayedRound(round: string | null | undefined): string {
  return round == null || round === "" || round === "?" ? "" : round;
}

function displayedDate(date: string | null | undefined): string {
  return (
    date
      ?.split(".")
      .filter((part) => !part.includes("?"))
      .join(".") ?? ""
  );
}

export function formatEventDateRange(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): string {
  const start = displayedDate(startDate);
  const end = displayedDate(endDate);
  if (!start || !end || start === end) return start;
  const [startYear] = start.split(".");
  const [endYear, endMonth] = end.split(".");
  const rangeEnd = startYear === endYear && endMonth ? end.slice(endYear.length + 1) : end;
  return `${start} – ${rangeEnd}`;
}
