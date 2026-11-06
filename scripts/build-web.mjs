// Builds the web app into apps/web/dist with esbuild and checks that every
// language has exactly the same message keys (a missing translation fails the build).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps/web");
const dist = path.join(web, "dist");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(web, "src/main.tsx")],
  bundle: true,
  minify: process.env.NODE_ENV === "production",
  sourcemap: true,
  format: "iife",
  target: ["es2020"],
  jsx: "automatic",
  outfile: path.join(dist, "app.js"),
  nodePaths: [path.join(root, "node_modules"), ...(process.env.EXTRA_NODE_PATH ? [process.env.EXTRA_NODE_PATH] : [])],
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development") },
  logLevel: "warning",
});

for (const f of fs.readdirSync(path.join(web, "public"))) fs.copyFileSync(path.join(web, "public", f), path.join(dist, f));

// translation completeness check
const tmp = path.join(dist, "_messages.mjs");
await build({ entryPoints: [path.join(web, "src/i18n/messages.ts")], outfile: tmp, format: "esm", bundle: true, logLevel: "error" });
const { MESSAGES } = await import(tmp);
fs.rmSync(tmp);
const keys = Object.fromEntries(Object.entries(MESSAGES).map(([l, d]) => [l, new Set(Object.keys(d))]));
let missing = 0;
for (const [l, set] of Object.entries(keys)) {
  for (const [o, other] of Object.entries(keys)) {
    for (const k of other) if (!set.has(k)) { console.error(`missing ${l}: ${k} (present in ${o})`); missing++; }
  }
}
if (missing) { console.error(`${missing} missing translations`); process.exit(1); }

// translation quality: same {placeholders} in every language; Arabic text really in Arabic
const LATIN_OK_IN_ARABIC = new Set(["app.name", "lang.en", "lang.fr"]); // product name, language names in their own script
const holders = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(",");
let bad = 0;
for (const k of keys.en) {
  for (const l of Object.keys(MESSAGES)) {
    if (holders(MESSAGES[l][k]) !== holders(MESSAGES.en[k])) { console.error(`placeholders differ in ${l}: ${k}`); bad++; }
  }
  if (!LATIN_OK_IN_ARABIC.has(k) && !/[\u0600-\u06FF]/.test(MESSAGES.ar[k])) { console.error(`not translated to Arabic: ${k} = ${MESSAGES.ar[k]}`); bad++; }
}

// right-to-left safety: no physical left/right in CSS (use start/end, inline-start/-end) unless marked /* ltr-ok */
const css = fs.readFileSync(path.join(web, "public/styles.css"), "utf8").split("\n");
css.forEach((line, i) => {
  if (/(margin|padding|border)-(left|right)\b|(^|[\s;{])(left|right)\s*:|text-align:\s*(left|right)|float:\s*(left|right)/.test(line) && !line.includes("ltr-ok")) {
    console.error(`styles.css:${i + 1} uses left/right; use start/end so Arabic (RTL) mirrors correctly`); bad++;
  }
});
if (bad) { console.error(`${bad} language/RTL problem(s)`); process.exit(1); }
console.log(`web built → ${path.relative(root, dist)} (${Object.keys(MESSAGES).join(", ")}: ${keys.en.size} keys each)`);
