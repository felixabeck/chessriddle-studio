import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearProgress: vi.fn(),
  getProgress: vi.fn(),
  listen: vi.fn(),
  notifyListenerError: vi.fn(),
}));

vi.mock("@/components/files/notifyError", () => ({
  notifyListenerError: mocks.notifyListenerError,
}));

vi.mock("@/bindings/generated", () => ({
  commands: {
    clearProgress: mocks.clearProgress,
    getProgress: mocks.getProgress,
  },
  events: {
    progressEvent: { listen: mocks.listen },
  },
}));

import { useProgress } from "./useProgress";

type Progress = {
  id: string;
  generation: string;
  progress: number;
  finished: boolean;
  state: "running" | "succeeded" | "failed" | "cancelled";
  cleared: boolean;
  count?: number | null;
};

let eventHandler: ((event: { payload: Progress }) => void) | undefined;
let root: Root;
let container: HTMLDivElement;

function Probe({ id }: { id: string | null | undefined }) {
  const state = useProgress(id);
  const count = state.item?.count ?? null;
  return (
    <>
      <output
        data-generation={state.item?.generation.toString() ?? "none"}
        data-count={count === null ? "none" : String(count)}
      >
        {state.progress}:{String(state.finished)}
      </output>
      <button onClick={() => void state.clear()}>clear</button>
      <button onClick={() => state.fence(BigInt(5))}>fence</button>
      <button onClick={() => state.fence(null)}>discard</button>
    </>
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  eventHandler = undefined;
  mocks.clearProgress.mockReset();
  mocks.clearProgress.mockResolvedValue({ status: "ok", data: "0" });
  mocks.getProgress.mockReset();
  mocks.listen.mockReset();
  mocks.notifyListenerError.mockReset();
  mocks.listen.mockImplementation(async (handler: (event: { payload: Progress }) => void) => {
    eventHandler = handler;
    return vi.fn();
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("useProgress", () => {
  test.each(["9007199254740993", "18446744073709551615"])(
    "a null fence hides %s and rejects old snapshots and malformed events",
    async (generation) => {
      let resolveInitial!: (value: Progress) => void;
      mocks.getProgress.mockReturnValue(
        new Promise<Progress>((resolve) => {
          resolveInitial = resolve;
        }),
      );
      await act(async () => root.render(<Probe id="job" />));
      const payload: Progress = {
        id: "job",
        generation,
        progress: 35,
        finished: false,
        state: "running",
        cleared: false,
      };
      await act(async () => eventHandler?.({ payload }));
      expect(container.querySelector("output")?.dataset.generation).toBe(generation);
      await act(async () =>
        eventHandler?.({ payload: { ...payload, generation: "01", progress: 99, cleared: true } }),
      );
      expect(container.querySelector("output")?.textContent).toBe("35:false");
      expect(mocks.notifyListenerError).toHaveBeenCalledOnce();
      await act(async () => container.querySelectorAll("button")[2]?.click());
      await act(async () => {
        eventHandler?.({ payload: { ...payload, progress: 90 } });
        resolveInitial({ ...payload, progress: 100, finished: true, state: "failed" });
      });
      expect(container.querySelector("output")?.dataset.generation).toBe("none");
      if (generation !== "18446744073709551615") {
        await act(async () =>
          eventHandler?.({
            payload: { ...payload, generation: (BigInt(generation) + 1n).toString(), progress: 20 },
          }),
        );
      }
      expect(container.querySelector("output")?.dataset.generation).toBe(
        generation === "18446744073709551615" ? "none" : "9007199254740994",
      );
    },
  );
  test("fence(null) discards terminal progress from a decimal string wire event", async () => {
    mocks.getProgress.mockResolvedValue(null);
    await act(async () => root.render(<Probe id="job" />));
    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "5",
          progress: 100,
          finished: true,
          state: "failed",
          cleared: false,
        },
      });
    });
    expect(container.querySelector("output")?.textContent).toBe("100:true");
    await act(async () => container.querySelectorAll("button")[2]?.click());
    expect(container.querySelector("output")?.dataset.generation).toBe("none");
    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "5",
          progress: 100,
          finished: true,
          state: "failed",
          cleared: false,
        },
      });
    });
    expect(container.querySelector("output")?.dataset.generation).toBe("none");
    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "6",
          progress: 10,
          finished: false,
          state: "running",
          cleared: false,
        },
      });
    });
    expect(container.querySelector("output")?.dataset.generation).toBe("6");
  });

  test("keeps the newest generation when the initial lookup resolves late", async () => {
    let resolveInitial: (value: Progress) => void = () => undefined;
    mocks.getProgress.mockReturnValue(
      new Promise<Progress>((resolve) => {
        resolveInitial = resolve;
      }),
    );

    await act(async () => root.render(<Probe id="job" />));
    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "2",
          progress: 60,
          finished: false,
          state: "running",
          cleared: false,
        },
      });
    });
    await act(async () => {
      resolveInitial({
        id: "job",
        generation: "1",
        progress: 100,
        finished: true,
        state: "succeeded",
        cleared: false,
      });
    });

    expect(container.querySelector("output")?.textContent).toBe("60:false");
    expect(container.querySelector("output")?.dataset.generation).toBe("2");
  });

  test("rejects regressing events within the same generation", async () => {
    mocks.getProgress.mockResolvedValue(null);
    await act(async () => root.render(<Probe id="job" />));

    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "4",
          progress: 80,
          finished: true,
          state: "succeeded",
          cleared: false,
        },
      });
      eventHandler?.({
        payload: {
          id: "job",
          generation: "4",
          progress: 40,
          finished: false,
          state: "running",
          cleared: false,
        },
      });
    });

    expect(container.querySelector("output")?.textContent).toBe("80:true");
  });

  test("waits for listener registration before requesting a snapshot and repeats for a new id", async () => {
    let settleListener!: (unlisten: () => void) => void;
    mocks.listen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleListener = resolve;
        }),
    );
    mocks.getProgress.mockResolvedValue(null);

    await act(async () => root.render(<Probe id="first" />));
    expect(mocks.getProgress).not.toHaveBeenCalled();

    await act(async () => settleListener(vi.fn()));
    expect(mocks.getProgress).toHaveBeenCalledWith("first");

    await act(async () => root.render(<Probe id="second" />));
    expect(mocks.getProgress).toHaveBeenLastCalledWith("second");
  });

  test("a terminal item at zero replaces a running item at fifty", async () => {
    mocks.getProgress.mockResolvedValue(null);
    await act(async () => root.render(<Probe id="job" />));
    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "4",
          progress: 50,
          finished: false,
          state: "running",
          cleared: false,
        },
      });
      eventHandler?.({
        payload: {
          id: "job",
          generation: "4",
          progress: 0,
          finished: true,
          state: "cancelled",
          cleared: false,
        },
      });
    });

    expect(container.querySelector("output")?.textContent).toBe("0:true");
  });

  test("a delayed lower cleared event keeps the item and its generation floor", async () => {
    mocks.getProgress.mockResolvedValue(null);
    await act(async () => root.render(<Probe id="job" />));
    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "9",
          progress: 0,
          finished: true,
          state: "cancelled",
          cleared: true,
        },
      });
      eventHandler?.({
        payload: {
          id: "job",
          generation: "10",
          progress: 50,
          finished: false,
          state: "running",
          cleared: false,
        },
      });
      eventHandler?.({
        payload: {
          id: "job",
          generation: "7",
          progress: 0,
          finished: true,
          state: "cancelled",
          cleared: true,
        },
      });
      eventHandler?.({
        payload: {
          id: "job",
          generation: "8",
          progress: 100,
          finished: true,
          state: "succeeded",
          cleared: false,
        },
      });
    });

    expect(container.querySelector("output")?.textContent).toBe("50:false");
    expect(container.querySelector("output")?.dataset.generation).toBe("10");
  });

  test("fences displayed and undisplayed generations", async () => {
    mocks.getProgress.mockResolvedValue(null);
    await act(async () => root.render(<Probe id="job" />));
    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "3",
          progress: 40,
          finished: false,
          state: "running",
          cleared: false,
        },
      });
      container.querySelectorAll("button")[1]?.click();
    });
    expect(container.querySelector("output")?.dataset.generation).toBe("none");

    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "4",
          progress: 100,
          finished: true,
          state: "succeeded",
          cleared: false,
        },
      });
    });
    expect(container.querySelector("output")?.dataset.generation).toBe("none");

    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "5",
          progress: 20,
          finished: false,
          state: "running",
          cleared: false,
        },
      });
    });
    expect(container.querySelector("output")?.dataset.generation).toBe("5");
  });

  test("discard hides the current generation but accepts a higher one", async () => {
    mocks.getProgress.mockResolvedValue(null);
    await act(async () => root.render(<Probe id="job" />));
    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "5",
          progress: 50,
          finished: false,
          state: "running",
          cleared: false,
        },
      });
      container.querySelectorAll("button")[2]?.click();
    });
    expect(container.querySelector("output")?.dataset.generation).toBe("none");

    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "6",
          progress: 10,
          finished: false,
          state: "running",
          cleared: false,
        },
      });
    });
    expect(container.querySelector("output")?.dataset.generation).toBe("6");
  });

  test("requests a snapshot after listener registration is rejected", async () => {
    mocks.listen.mockRejectedValueOnce(new Error("listener unavailable"));
    mocks.getProgress.mockResolvedValue({
      id: "job",
      generation: "2",
      progress: 25,
      finished: false,
      state: "running",
      cleared: false,
    });

    await act(async () => root.render(<Probe id="job" />));
    await vi.waitFor(() => expect(mocks.getProgress).toHaveBeenCalledWith("job"));
    expect(container.querySelector("output")?.dataset.generation).toBe("2");
  });

  test("clear establishes a generation floor that ignores an old producer", async () => {
    mocks.getProgress.mockResolvedValue(null);
    mocks.clearProgress.mockResolvedValue({ status: "ok", data: "8" });
    await act(async () => root.render(<Probe id="job" />));
    await act(async () => {
      container.querySelector("button")?.click();
    });
    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "7",
          progress: 100,
          finished: true,
          state: "succeeded",
          cleared: false,
        },
      });
    });
    expect(container.querySelector("output")?.dataset.generation).toBe("none");
  });

  test("a clear event from another window removes state and rejects its old producer", async () => {
    mocks.getProgress.mockResolvedValue(null);
    await act(async () => root.render(<Probe id="job" />));
    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "4",
          progress: 50,
          finished: false,
          state: "running",
          cleared: false,
        },
      });
      eventHandler?.({
        payload: {
          id: "job",
          generation: "5",
          progress: 0,
          finished: true,
          state: "cancelled",
          cleared: true,
        },
      });
      eventHandler?.({
        payload: {
          id: "job",
          generation: "4",
          progress: 100,
          finished: true,
          state: "succeeded",
          cleared: false,
        },
      });
    });
    expect(container.querySelector("output")?.dataset.generation).toBe("none");
  });

  test("drops a progress event whose id does not match the subscription", async () => {
    mocks.getProgress.mockResolvedValue(null);
    await act(async () => root.render(<Probe id="job" />));

    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "1",
          progress: 40,
          finished: false,
          state: "running",
          cleared: false,
        },
      });
      eventHandler?.({
        payload: {
          id: "other-job",
          generation: "2",
          progress: 90,
          finished: true,
          state: "succeeded",
          cleared: false,
        },
      });
    });

    expect(container.querySelector("output")?.textContent).toBe("40:false");
    expect(container.querySelector("output")?.dataset.generation).toBe("1");
  });

  test("changing IDs resets the generation floor and visible item", async () => {
    mocks.getProgress.mockImplementation(async (id: string) =>
      id === "first"
        ? {
            id,
            generation: "8",
            progress: 50,
            finished: false,
            state: "running",
          }
        : {
            id,
            generation: "1",
            progress: 25,
            finished: false,
            state: "running",
          },
    );
    await act(async () => root.render(<Probe id="first" />));
    expect(container.querySelector("output")?.dataset.generation).toBe("8");
    await act(async () => root.render(<Probe id="second" />));
    expect(container.querySelector("output")?.dataset.generation).toBe("1");
  });

  test("an old clear acknowledgement cannot clear a replacement id", async () => {
    let resolveClear: (value: { status: "ok"; data: string }) => void = () => undefined;
    mocks.clearProgress.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveClear = resolve;
      }),
    );
    mocks.getProgress.mockImplementation(async (id: string) =>
      id === "second"
        ? {
            id,
            generation: "1",
            progress: 35,
            finished: false,
            state: "running",
          }
        : null,
    );
    await act(async () => root.render(<Probe id="first" />));
    await act(async () => container.querySelector("button")?.click());
    await act(async () => root.render(<Probe id="second" />));
    expect(container.querySelector("output")?.textContent).toBe("35:false");

    await act(async () => resolveClear({ status: "ok", data: "9" }));
    expect(container.querySelector("output")?.textContent).toBe("35:false");
    expect(container.querySelector("output")?.dataset.generation).toBe("1");
  });

  test("surfaces a rejected initial progress lookup", async () => {
    const failure = new Error("progress lookup failed");
    mocks.getProgress.mockRejectedValue(failure);
    await act(async () => root.render(<Probe id="job" />));
    await vi.waitFor(() =>
      expect(mocks.notifyListenerError).toHaveBeenCalledWith(
        expect.objectContaining({ message: failure.message }),
      ),
    );
    expect(container.querySelector("output")?.dataset.generation).toBe("none");
  });

  test("an absent id subscribes to nothing, skips getProgress, and returns empty state", async () => {
    mocks.getProgress.mockResolvedValue(null);
    await act(async () => root.render(<Probe id={null} />));
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.getProgress).not.toHaveBeenCalled();
    expect(container.querySelector("output")?.textContent).toBe("0:false");
    expect(container.querySelector("output")?.dataset.generation).toBe("none");
    expect(container.querySelector("output")?.dataset.count).toBe("none");

    await act(async () => container.querySelector("button")?.click());
    expect(mocks.clearProgress).not.toHaveBeenCalled();

    // Transitioning to a real id subscribes first, then hydrates.
    await act(async () => root.render(<Probe id="job" />));
    expect(mocks.listen).toHaveBeenCalledOnce();
    expect(mocks.getProgress).toHaveBeenCalledWith("job");
  });

  test("waits for listener registration after returning from an absent id before hydrating the replacement id", async () => {
    mocks.getProgress.mockResolvedValue(null);
    await act(async () => root.render(<Probe id="job" />));
    expect(mocks.getProgress).toHaveBeenCalledExactlyOnceWith("job");

    await act(async () => root.render(<Probe id={null} />));

    let settleReplacement!: (unlisten: () => void) => void;
    mocks.listen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleReplacement = resolve;
        }),
    );

    await act(async () => root.render(<Probe id="job2" />));
    expect(mocks.getProgress).not.toHaveBeenCalledWith("job2");

    await act(async () => settleReplacement(vi.fn()));
    expect(mocks.getProgress).toHaveBeenLastCalledWith("job2");
  });

  test("a late getProgress snapshot with equal generation and progress and a lower count does not overwrite a newer count", async () => {
    let resolveInitial!: (value: Progress | null) => void;
    mocks.getProgress.mockReturnValue(
      new Promise<Progress | null>((resolve) => {
        resolveInitial = resolve;
      }),
    );

    await act(async () => root.render(<Probe id="job" />));
    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "3",
          progress: 0,
          finished: false,
          state: "running",
          cleared: false,
          count: 150,
        },
      });
    });
    expect(container.querySelector("output")?.dataset.count).toBe("150");

    await act(async () => {
      resolveInitial({
        id: "job",
        generation: "3",
        progress: 0,
        finished: false,
        state: "running",
        cleared: false,
        count: 40,
      });
    });
    expect(container.querySelector("output")?.dataset.count).toBe("150");

    // A count-less update with equal generation and progress also keeps the newer count.
    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "3",
          progress: 0,
          finished: false,
          state: "running",
          cleared: false,
          count: null,
        },
      });
    });
    expect(container.querySelector("output")?.dataset.count).toBe("150");

    // A higher count with equal generation and progress replaces it.
    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "3",
          progress: 0,
          finished: false,
          state: "running",
          cleared: false,
          count: 200,
        },
      });
    });
    expect(container.querySelector("output")?.dataset.count).toBe("200");

    // A cleared event still clears the item and its count.
    await act(async () => {
      eventHandler?.({
        payload: {
          id: "job",
          generation: "4",
          progress: 0,
          finished: true,
          state: "cancelled",
          cleared: true,
          count: null,
        },
      });
    });
    expect(container.querySelector("output")?.dataset.generation).toBe("none");
    expect(container.querySelector("output")?.dataset.count).toBe("none");
  });
});
