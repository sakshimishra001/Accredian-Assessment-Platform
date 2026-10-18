/*
 * Where the self-hosted face-detection runtime and model are served from (our own domain — never a
 * CDN). scripts/copy-mediapipe-assets.mjs puts them there from the pinned @mediapipe/tasks-vision
 * package and assets/mediapipe/; a unit test keeps this version in step with the installed package.
 */

export const MEDIAPIPE_VERSION = "1.0.1";
const BASE = `/vendor/mediapipe/${MEDIAPIPE_VERSION}`;
/** Directory holding vision_wasm_internal.{js,wasm} and the no-SIMD fallback. */
export const FACE_WASM_PATH = `${BASE}/wasm`;
/** BlazeFace short-range (float16): faces within about 2 m of a front camera. */
export const FACE_MODEL_PATH = `${BASE}/blaze_face_short_range.tflite`;
