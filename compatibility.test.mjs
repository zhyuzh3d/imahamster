import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

function runtimeSources(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return runtimeSources(target);
    return /\.(?:js|mjs)$/.test(entry.name) && !entry.name.endsWith(".test.mjs") ? [target] : [];
  });
}

test("runtime sources stay compatible with the Android 11 WebView and embedded JS baseline", () => {
  const files = ["app.js", ...runtimeSources("agent"), ...runtimeSources("ui")];
  const unsupported = [
    ["logical assignment operators", /\?\?=|&&=|\|\|=/],
    ["Array.prototype.at", /\.at\s*\(/],
    ["Object.hasOwn", /\bObject\.hasOwn\s*\(/],
    ["Element.replaceChildren", /\.replaceChildren\s*\(/],
  ];
  const violations = [];

  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const [feature, pattern] of unsupported) {
      if (pattern.test(source)) violations.push(`${file}: ${feature}`);
    }
  }

  assert.deepEqual(violations, [], `Unsupported runtime features found:\n${violations.join("\n")}`);
});
