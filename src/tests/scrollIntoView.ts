// jsdom has no scrollIntoView. Mantine calls it while it moves the active option of an open
// list, so a test that opens one installs this for as long as it needs it. The returned function
// puts back what was there.
export function stubScrollIntoView(): () => void {
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    Element.prototype.scrollIntoView = () => {};
    return () => {
        if (original) Object.defineProperty(Element.prototype, "scrollIntoView", original);
        else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    };
}
