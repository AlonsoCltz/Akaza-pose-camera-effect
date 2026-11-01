import { startCamera } from "./camera.js";
import { createPoseLandmarker, PoseScorer } from "./pose.js";
import { createPersonSegmenter, PersonMask } from "./segment.js";
import { EffectController } from "./effects.js";

const video = /** @type {HTMLVideoElement} */ (document.getElementById("video"));
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("overlay"));
const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
const startOverlay = /** @type {HTMLElement} */ (document.getElementById("start-overlay"));
const enableBtn = /** @type {HTMLButtonElement} */ (document.getElementById("enable-camera"));
const errorText = /** @type {HTMLElement} */ (document.getElementById("error-text"));

const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2D canvas context unavailable");

const scorer = new PoseScorer();
const effects = new EffectController();

/** @type {import('@mediapipe/tasks-vision').PoseLandmarker | null} */
let landmarker = null;
/** @type {import('@mediapipe/tasks-vision').ImageSegmenter | null} */
let segmenter = null;
const personMask = new PersonMask();
let segmentFailed = false;
let running = false;
let lastVideoTime = -1;
/** @type {import('./pose.js').Landmark[] | undefined} */
let lastLandmarks;
let debug =
  new URLSearchParams(location.search).get("debug") === "1";

function showError(message) {
  errorText.hidden = false;
  errorText.textContent = message;
}

function clearError() {
  errorText.hidden = true;
  errorText.textContent = "";
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { clientWidth: w, clientHeight: h } = stage;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/**
 * Drawing size in CSS pixels (matches setTransform).
 */
function drawSize() {
  return {
    width: stage.clientWidth,
    height: stage.clientHeight,
  };
}

async function onEnableCamera() {
  clearError();
  enableBtn.disabled = true;
  enableBtn.textContent = "Starting…";

  try {
    await startCamera(video);
    if (!landmarker || !segmenter) {
      enableBtn.textContent = "Loading models…";
      const jobs = [];
      if (!landmarker) {
        jobs.push(createPoseLandmarker().then((model) => {
          landmarker = model;
        }));
      }
      if (!segmenter) {
        jobs.push(createPersonSegmenter().then((model) => {
          segmenter = model;
        }));
      }
      await Promise.all(jobs);
    }

    startOverlay.classList.add("is-hidden");
    stage.classList.add("is-running");
    running = true;
    resizeCanvas();
    requestAnimationFrame(frame);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start.";
    showError(message);
    enableBtn.disabled = false;
    enableBtn.textContent = "Enable camera";
  }
}

/**
 * @param {DOMHighResTimeStamp} now
 */
function frame(now) {
  if (!running || !landmarker) return;

  const { width, height } = drawSize();
  /** @type {import('./pose.js').Landmark[] | undefined} */
  let landmarks;

  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = landmarker.detectForVideo(video, now);
    landmarks = result.landmarks?.[0];
    lastLandmarks = landmarks;
    if (segmenter && !segmentFailed) {
      try {
        personMask.update(segmenter, video, now);
      } catch (err) {
        segmentFailed = true;
        console.error(err);
      }
    }
  } else {
    landmarks = lastLandmarks;
  }

  const pose = scorer.update(landmarks);
  effects.update(pose.aboveThreshold, now);
  effects.draw(ctx, width, height, landmarks, {
    debug,
    score: pose.smoothed,
    breakdown: pose.breakdown,
    mask: personMask.ready ? personMask.canvas : null,
    maskBox: personMask.box,
    cover: videoCover(video, width, height),
  });

  requestAnimationFrame(frame);
}

enableBtn.addEventListener("click", () => {
  void onEnableCamera();
});

window.addEventListener("resize", () => {
  if (running) resizeCanvas();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "d" || e.key === "D") {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }
    debug = !debug;
  }
});

resizeCanvas();

/**
 * Object-fit: cover rect for the camera frame inside the stage.
 * The video element is mirrored around the stage, and landmark x is flipped to match.
 * @param {HTMLVideoElement} videoEl
 */
function videoCover(videoEl, viewW, viewH) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return { ox: 0, oy: 0, dw: viewW, dh: viewH };
  const scale = Math.max(viewW / vw, viewH / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  return { ox: (viewW - dw) / 2, oy: (viewH - dh) / 2, dw, dh };
}
