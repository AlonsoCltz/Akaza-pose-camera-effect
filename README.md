# 青銀乱残光 — Akaza pose camera effect

Browser-only webcam demo. Hold Akaza’s deep squat (one open palm forward, the other at the hip) to trigger a procedural blue-silver VFX overlay. No backend and no install step.

## Launch

Serve the `app` folder over localhost. `file://` and a LAN address such as `http://192.168…` block the camera and MediaPipe WASM.

```bash
cd app
npx --yes serve . -l 3456
```

Open **http://localhost:3456** in desktop **Chrome**. Do not use Cursor’s Simple Browser. Allow the camera when prompted, then step back so your full body fits in frame.

## Libraries

Loaded in the browser from a CDN. There is no `package.json`.

| Library | Version | Role |
|---|---|---|
| [`@mediapipe/tasks-vision`](https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs) | 0.10.18 | Vision runtime. WASM from the same jsDelivr package. GPU delegate, CPU if the GPU delegate fails. |
| [Pose Landmarker lite](https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task) | float16 | 33 body landmarks, one person, `VIDEO` mode. |
| [Selfie Segmenter](https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite) | float16 | Person cutout used for the red flank figures. |

Browser APIs: `getUserMedia` (user-facing camera, ideal 1280×720), `requestAnimationFrame`, and Canvas 2D. The page is vanilla HTML, CSS, and ES modules.

## Flow

```
Enable camera
  → getUserMedia
  → load Pose Landmarker and Selfie Segmenter
  → each video frame
       pose landmarks → squat score
       person mask → red cutout
       effect state → canvas overlay
```

1. **Start.** The Enable camera button calls `startCamera` in `js/camera.js`, then loads both models.
2. **Frame loop** (`js/main.js`). On each new video frame, `detectForVideo` returns landmarks and `segmentForVideo` paints a red silhouette. The video is mirrored; landmark x is flipped to match.
3. **Pose score** (`js/pose.js`). Knee bend, hip drop, stance width, and the two palm positions combine into one score, smoothed with an exponential moving average. Above **0.62** counts as holding the pose.
4. **Effect** (`js/effects.js`). `idle` → `charging` (hold **0.5s**) → `active` → `fading` (**2s** after you break the pose) → `cooldown` (**1s**) → `idle`.
5. **Draw.** While the effect is visible, the canvas paints a dark-blue grade with a hole on you, a floor compass, two red copies of the cutout, vertical lines, diamond particles, and the kanji `青銀乱残光`.

## Pose

1. Deep wide squat (knees bent, feet apart)
2. One open palm forward toward the camera
3. Other open palm near the hip
4. Hold about **0.5s** to trigger

## Debug

Add `?debug=1` to the URL, or press **D**, for the skeleton overlay, pose score, and effect state.
