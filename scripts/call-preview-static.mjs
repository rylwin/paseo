import { readFile } from "node:fs/promises";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { resolve, extname } from "node:path";

const compress = promisify(gzip);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json",
};

export async function loadPreviewAsset(root, url, compressed) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  if (pathname.includes("\\") || pathname.split("/").some((part) => part.startsWith(".")))
    throw new Error("Invalid preview asset path");
  const file = resolve(root, extname(pathname) ? `.${pathname}` : "index.html");
  const bytes = await readFile(file);
  return {
    body: compressed ? await compress(bytes) : bytes,
    type: types[extname(file)] ?? "application/octet-stream",
    encoding: compressed ? "gzip" : null,
  };
}
