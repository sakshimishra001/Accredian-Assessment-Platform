/**
 * Self-hosted face-detection assets (proctoring step 5). Copies the MediaPipe WASM runtime from the
 * pinned npm package, and the BlazeFace short-range model kept in this repository, into
 * public/vendor/mediapipe/<version>/ — served from our own domain, so nothing is fetched from Google
 * or a CDN during an exam. The output is git-ignored and rebuilt by `npm install` (postinstall) and
 * `npm run build` (prebuild). Idempotent: files already identical are left alone.
 *
 *   node scripts/copy-mediapipe-assets.mjs
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = path.join(root, "node_modules", "@mediapipe", "tasks-vision");
const { version } = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const out = path.join(root, "public", "vendor", "mediapipe", version);

/** The model's SHA-256, checked on every copy (blaze_face_short_range, float16, v1). */
const MODEL = { file: "blaze_face_short_range.tflite", sha256: "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f" };
/** What FilesetResolver.forVisionTasks() loads: the SIMD build, and the fallback for browsers without WASM SIMD. */
const WASM = ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"];

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const same = (a, b) => existsSync(b) && statSync(a).size === statSync(b).size && sha256(a) === sha256(b);

function copy(from, to) {
  if (!existsSync(from)) throw new Error(`Missing ${path.relative(root, from)}`);
  mkdirSync(path.dirname(to), { recursive: true });
  if (!same(from, to)) copyFileSync(from, to);
}

const model = path.join(root, "assets", "mediapipe", MODEL.file);
if (sha256(model) !== MODEL.sha256) throw new Error(`${MODEL.file} doesn't match its recorded SHA-256; refusing to publish it.`);
copy(model, path.join(out, MODEL.file));
for (const f of WASM) copy(path.join(pkgDir, "wasm", f), path.join(out, "wasm", f));
console.log(`MediaPipe ${version} face-detection assets ready in ${path.relative(root, out)}`);
