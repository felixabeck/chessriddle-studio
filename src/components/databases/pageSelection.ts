// Page-local arrow navigation shared by the Library tables. With no selection on the loaded
// page, ArrowDown enters the table at its first row (so the keyboard can make a first
// selection) and ArrowUp stays put. At either edge the selection is kept.
export function getAdjacentRecordId(
    records: readonly { id: number }[],
    selectedId: number | undefined,
    direction: -1 | 1,
): number | undefined {
    const currentIndex = records.findIndex((record) => record.id === selectedId);
    if (currentIndex === -1) {
        return direction === 1 ? records[0]?.id : undefined;
    }
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= records.length) {
        return undefined;
    }
    return records[nextIndex].id;
}
