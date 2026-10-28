import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { ComposerDock } from "./index";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SAFE_AREAS = [
  { top: 0, left: 0, right: 0, bottom: 0 },
  { top: 0, left: 0, right: 0, bottom: 34 },
];
const COMPOSER_STYLE: React.CSSProperties = {
  height: 120,
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-end",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  Object.assign(container.style, { display: "flex", width: "390px", height: "600px" });
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it.each(SAFE_AREAS)(
  "keeps the browser composer above a $bottom px bottom safe area",
  async (insets) => {
    await act(async () => {
      root.render(
        <SafeAreaInsetsContext.Provider value={insets}>
          <ComposerDock>
            <div>Conversation</div>
            <div style={COMPOSER_STYLE}>
              <button type="button">Send</button>
            </div>
          </ComposerDock>
        </SafeAreaInsetsContext.Provider>,
      );
    });

    await expect
      .poll(() => {
        const send = container.querySelector("button")!.getBoundingClientRect();
        return send.bottom - container.getBoundingClientRect().bottom;
      })
      .toBeCloseTo(-insets.bottom, 4);
  },
);
