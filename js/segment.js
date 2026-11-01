import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";

const WASM_ROOT =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

/**
 * Person cutout. GPU first, CPU if the delegate is unavailable.
 * @param {"VIDEO" | "IMAGE"} [runningMode]
 * @returns {Promise<ImageSegmenter>}
 */
export async function createPersonSegmenter(runningMode = "VIDEO") {
  const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
  const model = { modelAssetPath: MODEL_URL };
  const shared = {
    runningMode,
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  };

  try {
    return await ImageSegmenter.createFromOptions(vision, {
      ...shared,
      baseOptions: { ...model, delegate: "GPU" },
    });
  } catch {
    return await ImageSegmenter.createFromOptions(vision, {
      ...shared,
      baseOptions: { ...model, delegate: "CPU" },
    });
  }
}

/**
 * Paints the selfie-segmenter mask as a red silhouette (alpha = person).
 */
export class PersonMask {
  constructor() {
    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Mask canvas unavailable");
    this.ctx = ctx;
    this.ready = false;
    /** @type {boolean | null} true when a high mask value means "person" */
    this.personIsHigh = null;
    /**
     * Tight box around opaque person pixels, in mask-pixel space.
     * @type {{ x0: number, y0: number, x1: number, y1: number, width: number, height: number } | null}
     */
    this.box = null;
  }

  /**
   * @param {ImageSegmenter} segmenter
   * @param {HTMLVideoElement} video
   * @param {number} timestamp
   */
  update(segmenter, video, timestamp) {
    const result = segmenter.segmentForVideo(video, timestamp);
    this._consume(result);
  }

  /**
   * @param {import('@mediapipe/tasks-vision').ImageSegmenterResult | undefined} result
   */
  _consume(result) {
    try {
      const masks = result?.confidenceMasks;
      if (!masks?.length) return;
      const mask = masks[masks.length - 1];
      const width = mask.width;
      const height = mask.height;
      const src = mask.getAsFloat32Array();
      this._paint(src, width, height);
      this.ready = true;
    } finally {
      result?.close?.();
    }
  }

  /**
   * @param {Float32Array} src
   * @param {number} width
   * @param {number} height
   */
  _paint(src, width, height) {
    const personIsHigh = this._resolvePolarity(src, width, height);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    const img = this.ctx.createImageData(width, height);
    const px = img.data;
    const n = width * height;
    let x0 = width;
    let y0 = height;
    let x1 = 0;
    let y1 = 0;
    let solid = 0;
    for (let i = 0; i < n; i++) {
      let p = src[i] ?? 0;
      if (p > 1) p /= 255;
      if (!personIsHigh) p = 1 - p;
      const a = p <= 0.32 ? 0 : p >= 0.68 ? 255 : ((p - 0.32) / 0.36) * 255;
      const o = i * 4;
      px[o] = 255;
      px[o + 1] = 18;
      px[o + 2] = 34;
      px[o + 3] = a;
      if (a > 150) {
        const x = i % width;
        const y = (i / width) | 0;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        solid += 1;
      }
    }
    this.box = solid > 24 ? { x0, y0, x1, y1, width, height } : null;
    this.ctx.putImageData(img, 0, 0);
  }

  /**
   * Lock polarity once the center of the frame is clearly different from the corners.
   * Until then, treat high values as the person (selfie model default).
   * @param {Float32Array} src
   */
  _resolvePolarity(src, width, height) {
    if (this.personIsHigh != null) return this.personIsHigh;

    const at = (x, y) => {
      const v = src[(Math.max(0, y) | 0) * width + (Math.max(0, x) | 0)] ?? 0;
      return v > 1 ? v / 255 : v;
    };
    const center = at(width * 0.5, height * 0.42);
    const corner =
      (at(1, 1) +
        at(width - 2, 1) +
        at(1, height - 2) +
        at(width - 2, height - 2)) /
      4;

    if (Math.abs(center - corner) >= 0.12) {
      this.personIsHigh = center > corner;
    }
    return this.personIsHigh ?? true;
  }
}
