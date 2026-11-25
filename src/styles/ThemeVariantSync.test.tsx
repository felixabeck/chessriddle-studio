import type { MantineColorScheme, MantineColorSchemeManager } from "@mantine/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installMatchMediaStub();

vi.mock("@/platform/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/native")>()),
  warn: vi.fn().mockResolvedValue(undefined),
}));

type Scheme = MantineColorScheme;

function stubSchemeManager(scheme: Scheme): MantineColorSchemeManager {
  return {
    get: () => scheme,
    set: () => undefined,
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    clear: () => undefined,
  };
}

let session:
  | {
      act: (callback: () => void | Promise<void>) => Promise<void>;
      root: { unmount: () => void };
    }
  | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.documentElement.removeAttribute("data-cf-theme-variant");
});

afterEach(async () => {
  if (session) {
    await session.act(() => session!.root.unmount());
    session = undefined;
  }
  host?.remove();
  host = undefined;
  document.documentElement.removeAttribute("data-cf-theme-variant");
  localStorage.clear();
});

async function renderSync({
  variant,
  scheme,
  extra,
}: {
  variant: "default" | "dim";
  scheme: Scheme;
  extra?: (react: typeof import("react")) => import("react").ReactNode;
}) {
  localStorage.setItem("theme-variant", JSON.stringify(variant));
  const react = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DEFAULT_THEME, MantineProvider, mergeMantineTheme, useMantineColorScheme } =
    await import("@mantine/core");
  const { createStore, Provider } = await import("jotai");
  const { createAppTheme } = await import("@/styles/theme");
  const { default: ThemeVariantSync } = await import("./ThemeVariantSync");
  const { themeVariantAtom } = await import("@/state/atoms");
  const theme = mergeMantineTheme(
    DEFAULT_THEME,
    createAppTheme({ spellCheck: true, fontSize: 100 }),
  );
  const store = createStore();
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let setColorScheme: (next: Scheme) => void = () => undefined;
  function BindScheme() {
    setColorScheme = useMantineColorScheme().setColorScheme;
    return null;
  }
  await react.act(async () => {
    root.render(
      <Provider store={store}>
        <MantineProvider
          colorSchemeManager={stubSchemeManager(scheme)}
          defaultColorScheme={scheme}
          theme={theme}
        >
          <ThemeVariantSync />
          {extra?.(react)}
          <BindScheme />
        </MantineProvider>
      </Provider>,
    );
  });
  session = { act: react.act, root };
  return { host, store, themeVariantAtom, setColorScheme };
}

test("stored dim and dark scheme apply the dim attribute and override CSS", async () => {
  const { host: page } = await renderSync({ variant: "dim", scheme: "dark" });
  expect(document.documentElement.getAttribute("data-cf-theme-variant")).toBe("dim");
  const css = [...page.querySelectorAll("style")].map((node) => node.textContent ?? "").join("\n");
  expect(css).toContain('[data-cf-theme-variant="dim"]');
  expect(css).toContain("--cf-background: hsl(30 6% 16%)");
});

test.each(["auto", "light"] as const)(
  "stored dim with scheme %s does not set the dim attribute",
  async (scheme) => {
    await renderSync({ variant: "dim", scheme });
    expect(document.documentElement.hasAttribute("data-cf-theme-variant")).toBe(false);
  },
);

test("switching the variant or scheme at runtime adds and removes the dim attribute", async () => {
  const { store, themeVariantAtom, setColorScheme } = await renderSync({
    variant: "dim",
    scheme: "dark",
  });
  expect(document.documentElement.getAttribute("data-cf-theme-variant")).toBe("dim");

  await session!.act(() => {
    store.set(themeVariantAtom, "default");
  });
  expect(document.documentElement.hasAttribute("data-cf-theme-variant")).toBe(false);

  await session!.act(() => {
    store.set(themeVariantAtom, "dim");
  });
  expect(document.documentElement.getAttribute("data-cf-theme-variant")).toBe("dim");

  await session!.act(() => {
    setColorScheme("light");
  });
  expect(document.documentElement.hasAttribute("data-cf-theme-variant")).toBe(false);

  await session!.act(() => {
    setColorScheme("dark");
  });
  expect(document.documentElement.getAttribute("data-cf-theme-variant")).toBe("dim");
});

test("a sibling probe sees dim on its first layout commit when dim is stored before atoms load", async () => {
  localStorage.setItem("theme-variant", JSON.stringify("dim"));
  let first: string | null | undefined;
  await renderSync({
    variant: "dim",
    scheme: "dark",
    extra: (react) => {
      function Probe() {
        const seen = react.useRef(false);
        react.useLayoutEffect(() => {
          if (seen.current) return;
          seen.current = true;
          first = document.documentElement.getAttribute("data-cf-theme-variant");
        }, [seen]);
        return null;
      }
      return <Probe />;
    },
  });
  expect(first).toBe("dim");
});
