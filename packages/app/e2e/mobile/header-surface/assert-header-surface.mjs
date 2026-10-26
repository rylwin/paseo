// Capture a populated compact workspace with history scrolled behind its header on Android.
// node assert-header-surface.mjs <screenshot.png> <uiautomator.xml> [geometry-baseline.xml]
// Uses real native pixels, not the SVG/Unistyles test stubs. The narrow empty rail between
// menu and title must stay the same opaque surface as the empty leading gutter, in both themes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";

const [, , screenshot, hierarchy, baseline] = process.argv;
assert(screenshot && hierarchy, "Pass a native screenshot and matching UI hierarchy");
function bounds(xml, id) {
  const node = xml.match(new RegExp(`<node[^>]*resource-id="${id}"[^>]*>`))?.[0];
  assert(node, `Missing native node: ${id}`);
  const values = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  assert(values, `Missing bounds: ${id}`);
  return values.slice(1).map(Number);
}
const xml = readFileSync(hierarchy, "utf8");
const menu = bounds(xml, "menu-button");
const title = bounds(xml, "workspace-header-title");
const subtitle = bounds(xml, "workspace-header-subtitle");
const railX = Math.round((menu[2] + title[0]) / 2);
assert(title[0] - menu[2] >= 4, "Header must expose a glyph-free sampling rail");
const { data, info } = await sharp(screenshot)
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const pixel = (x, y) =>
  Array.from(data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3));
const surface = pixel(2, title[1]);
let worstDifference = 0;
for (let y = title[1]; y < subtitle[3]; y++) {
  for (const x of [2, railX]) {
    const color = pixel(x, y);
    worstDifference = Math.max(
      worstDifference,
      ...color.map((channel, i) => Math.abs(channel - surface[i])),
    );
  }
}
assert(
  worstDifference <= 2,
  `Chat bleeds through header surface: maximum channel difference ${worstDifference} (allowed 2)`,
);
if (baseline) {
  const previous = readFileSync(baseline, "utf8");
  for (const id of [
    "menu-button",
    "workspace-header-title",
    "workspace-header-subtitle",
    "conversation-call-start",
    "message-input-root",
  ]) {
    assert.deepEqual(bounds(xml, id), bounds(previous, id), `${id} geometry must not change`);
  }
}
console.log(JSON.stringify({ result: "PASS", surface, worstDifference, menu, title, subtitle }));
