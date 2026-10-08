import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the determinism rules from src/sim/fixed.ts. If this test fails, the sim
 * may desync between browsers even though every other test passes.
 */
const dir = join(import.meta.dirname, "..", "src", "sim");
const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

const forbidden: [RegExp, string][] = [
  [/Math\.(random|sin|cos|tan|asin|acos|atan|atan2|pow|exp|log|log2|log10|hypot|cbrt|fround|round)\b/, "non-deterministic or float Math function"],
  [/\bDate\b|\bperformance\b|setTimeout|setInterval|requestAnimationFrame/, "wall-clock time"],
  [/\bwindow\b|\bdocument\b|\bglobalThis\b/, "DOM / global access"],
  [/(^|[^\w.])\d+\.\d+/, "float literal"],
  [/\*\*/, "exponent operator"],
];

for (const f of files) {
  test(`sim/${f} follows the determinism rules`, () => {
    const raw = readFileSync(join(dir, f), "utf8");
    const src = stripComments(raw);
    for (const [re, why] of forbidden) {
      const m = src.match(re);
      assert.equal(m, null, `${f}: ${why}: "${m?.[0]}"`);
    }
    if (f !== "fixed.ts") {
      // Bare division gives floats. Use idiv()/fdiv() instead.
      const div = src.match(/[\w)\]]\s*\/\s*[\w(]/);
      assert.equal(div, null, `${f}: bare "/" division, use idiv(): "${div?.[0]}"`);
      assert.ok(!/Math\.sqrt/.test(src), `${f}: Math.sqrt, use isqrt()`);
    }
    // The sim may only import from itself.
    for (const m of raw.matchAll(/from\s+"([^"]+)"/g)) {
      assert.ok(m[1].startsWith("./"), `${f}: imports "${m[1]}" from outside src/sim`);
    }
  });
}
