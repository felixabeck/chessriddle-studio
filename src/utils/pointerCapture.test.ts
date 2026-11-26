import { expect, test, vi } from "vitest";
import { capturePointer, releasePointerCaptureSafely } from "./pointerCapture";

test("capturePointer returns true when capture succeeds or API is absent, and false when it throws", () => {
    const element = document.createElement("div");

    // Absent API returns true.
    expect(capturePointer(element, 1)).toBe(true);

    // Succeeding setPointerCapture returns true.
    const succeed = vi.fn();
    element.setPointerCapture = succeed;
    expect(capturePointer(element, 7)).toBe(true);
    expect(succeed).toHaveBeenCalledExactlyOnceWith(7);

    // Throwing setPointerCapture fails closed and returns false.
    element.setPointerCapture = vi.fn(() => {
        throw new DOMException("inactive pointer", "NotFoundError");
    });
    expect(capturePointer(element, 7)).toBe(false);
});

test("releasePointerCaptureSafely releases when held, falls back without hasPointerCapture, and swallows throws", () => {
    const element = document.createElement("div");

    // Absent APIs are a no-op.
    expect(() => releasePointerCaptureSafely(element, 1)).not.toThrow();

    // When hasPointerCapture returns false, releasePointerCapture is not called.
    const release = vi.fn();
    element.hasPointerCapture = vi.fn(() => false);
    element.releasePointerCapture = release;
    releasePointerCaptureSafely(element, 2);
    expect(release).not.toHaveBeenCalled();

    // When hasPointerCapture returns true, releasePointerCapture is called.
    element.hasPointerCapture = vi.fn(() => true);
    releasePointerCaptureSafely(element, 3);
    expect(release).toHaveBeenCalledExactlyOnceWith(3);

    // Throwing releasePointerCapture is swallowed.
    element.releasePointerCapture = vi.fn(() => {
        throw new DOMException("already released", "NotFoundError");
    });
    expect(() => releasePointerCaptureSafely(element, 3)).not.toThrow();

    // Without hasPointerCapture, releasePointerCapture is called directly and throws are swallowed.
    const fallbackElement = document.createElement("div");
    const fallbackRelease = vi.fn(() => {
        throw new DOMException("already released", "NotFoundError");
    });
    fallbackElement.releasePointerCapture = fallbackRelease;
    expect(() => releasePointerCaptureSafely(fallbackElement, 4)).not.toThrow();
    expect(fallbackRelease).toHaveBeenCalledExactlyOnceWith(4);
});
