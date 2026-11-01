import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

const WASM_ROOT =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const LM = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
};

const VIS_MIN = 0.5;
/** Ankles/knees are often partly cut off or low-confidence on a laptop camera. */
const LEG_VIS_MIN = 0.2;
const EMA_ALPHA = 0.35;
/**
 * A front-facing webcam flattens a real squat, and stepping back to fit
 * often crops the legs. 0.62 matches a moderate squat; the 500ms
 * hold still rejects a passing flinch.
 */
export const SCORE_THRESHOLD = 0.62;

/**
 * @typedef {{ x: number, y: number, z?: number, visibility?: number }} Landmark
 */

/**
 * Create PoseLandmarker (GPU preferred, CPU fallback).
 * @returns {Promise<PoseLandmarker>}
 */
export async function createPoseLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
  const base = {
    baseOptions: {
      modelAssetPath: MODEL_URL,
    },
    runningMode: "VIDEO",
    numPoses: 1,
  };

  try {
    return await PoseLandmarker.createFromOptions(vision, {
      ...base,
      baseOptions: { ...base.baseOptions, delegate: "GPU" },
    });
  } catch {
    return await PoseLandmarker.createFromOptions(vision, {
      ...base,
      baseOptions: { ...base.baseOptions, delegate: "CPU" },
    });
  }
}

/**
 * Stateful pose scorer with EMA smoothing.
 */
/**
 * @typedef {Object} PoseBreakdown
 * @property {number} score
 * @property {number} knees
 * @property {number} hips
 * @property {number} stance
 * @property {number} arms
 * @property {"ok" | "partial" | "missing"} legs
 */

export class PoseScorer {
  constructor() {
    /** @type {number} */
    this.smoothed = 0;
    /** @type {PoseBreakdown} */
    this.breakdown = emptyBreakdown();
  }

  reset() {
    this.smoothed = 0;
    this.breakdown = emptyBreakdown();
  }

  /**
   * @param {Landmark[] | undefined} landmarks
   * @returns {{ raw: number, smoothed: number, aboveThreshold: boolean, breakdown: PoseBreakdown }}
   */
  update(landmarks) {
    const detail = landmarks?.length ? scorePose(landmarks) : emptyBreakdown();
    this.smoothed = EMA_ALPHA * detail.score + (1 - EMA_ALPHA) * this.smoothed;
    this.breakdown = {
      score: this.smoothed,
      knees: smoothPart(this.breakdown.knees, detail.knees),
      hips: smoothPart(this.breakdown.hips, detail.hips),
      stance: smoothPart(this.breakdown.stance, detail.stance),
      arms: smoothPart(this.breakdown.arms, detail.arms),
      legs: detail.legs,
    };
    return {
      raw: detail.score,
      smoothed: this.smoothed,
      aboveThreshold: this.smoothed > SCORE_THRESHOLD,
      breakdown: this.breakdown,
    };
  }
}

/**
 * @param {Landmark[]} lm
 * @returns {PoseBreakdown}
 */
export function scorePose(lm) {
  const lShoulder = lm[LM.LEFT_SHOULDER];
  const rShoulder = lm[LM.RIGHT_SHOULDER];
  const lHip = lm[LM.LEFT_HIP];
  const rHip = lm[LM.RIGHT_HIP];
  const lKnee = lm[LM.LEFT_KNEE];
  const rKnee = lm[LM.RIGHT_KNEE];
  const lAnkle = lm[LM.LEFT_ANKLE];
  const rAnkle = lm[LM.RIGHT_ANKLE];
  const lElbow = lm[LM.LEFT_ELBOW];
  const rElbow = lm[LM.RIGHT_ELBOW];
  const lWrist = lm[LM.LEFT_WRIST];
  const rWrist = lm[LM.RIGHT_WRIST];

  if (
    !visible(lShoulder) ||
    !visible(rShoulder) ||
    !visible(lHip) ||
    !visible(rHip)
  ) {
    return emptyBreakdown();
  }

  const shoulderMid = mid(lShoulder, rShoulder);
  const hipMid = mid(lHip, rHip);
  const torso = dist(hipMid, shoulderMid);
  if (torso < 1e-4) return emptyBreakdown();

  const shoulderWidth = dist(lShoulder, rShoulder);

  // --- Squat components ---
  let squatParts = 0;
  let squatWeight = 0;

  const leftLegOk =
    visible(lHip) && visible(lKnee, LEG_VIS_MIN) && visible(lAnkle, LEG_VIS_MIN);
  const rightLegOk =
    visible(rHip) && visible(rKnee, LEG_VIS_MIN) && visible(rAnkle, LEG_VIS_MIN);

  // Full credit at a projected knee angle of ~115°. A real 90° squat
  // often still looks 110–130° from a front-facing webcam, because the
  // shin goes back into the camera instead of sideways.
  if (leftLegOk) {
    const ang = jointAngle(lHip, lKnee, lAnkle);
    squatParts += clamp01((150 - ang) / 35);
    squatWeight += 1;
  }
  if (rightLegOk) {
    const ang = jointAngle(rHip, rKnee, rAnkle);
    squatParts += clamp01((150 - ang) / 35);
    squatWeight += 1;
  }

  const kneeScore = squatWeight > 0 ? squatParts / squatWeight : 0;

  // Hips below shoulders (image y grows downward)
  const hipDrop = (hipMid.y - shoulderMid.y) / torso;
  const hipScore = clamp01((hipDrop - 0.15) / 0.35);

  // Feet apart
  let stanceScore = 0;
  if (leftLegOk && rightLegOk && shoulderWidth > 1e-4) {
    const ankleGap = dist(lAnkle, rAnkle) / shoulderWidth;
    stanceScore = clamp01((ankleGap - 0.2) / 0.2);
  }

  const squatScore = 0.45 * kneeScore + 0.35 * hipScore + 0.2 * stanceScore;

  // --- Arms: either mirror ---
  const configA = armsScore(
    { shoulder: lShoulder, elbow: lElbow, wrist: lWrist, hip: lHip },
    { shoulder: rShoulder, elbow: rElbow, wrist: rWrist, hip: rHip },
    torso
  );
  const configB = armsScore(
    { shoulder: rShoulder, elbow: rElbow, wrist: rWrist, hip: rHip },
    { shoulder: lShoulder, elbow: lElbow, wrist: lWrist, hip: lHip },
    torso
  );
  const arms = Math.max(configA.score, configB.score);
  const legs = leftLegOk && rightLegOk ? "ok" : leftLegOk || rightLegOk ? "partial" : "missing";

  return {
    score: clamp01(0.55 * squatScore + 0.45 * arms),
    knees: kneeScore,
    hips: hipScore,
    stance: stanceScore,
    arms,
    legs,
  };
}

/**
 * Forward palm on `fwd`, hip palm on `hipSide`.
 * @param {{ shoulder: Landmark, elbow: Landmark, wrist: Landmark, hip: Landmark }} fwd
 * @param {{ shoulder: Landmark, elbow: Landmark, wrist: Landmark, hip: Landmark }} hipSide
 * @param {number} torso
 * @returns {{ score: number }}
 */
function armsScore(fwd, hipSide, torso) {
  const forwardOk =
    visible(fwd.shoulder) && visible(fwd.elbow) && visible(fwd.wrist);
  const hipOk =
    visible(hipSide.shoulder) &&
    visible(hipSide.elbow) &&
    visible(hipSide.wrist) &&
    visible(hipSide.hip);

  if (!forwardOk || !hipOk) return { score: 0 };

  // Forward palm: prefer z (closer to camera = smaller z in MediaPipe).
  // Lite-model z for a palm pushed toward a webcam is usually well under 0.12.
  let forwardScore = 0;
  const zWrist = fwd.wrist.z;
  const zElbow = fwd.elbow.z;
  if (typeof zWrist === "number" && typeof zElbow === "number") {
    const zDelta = zElbow - zWrist; // positive if wrist closer to camera
    forwardScore = clamp01(zDelta / 0.05);
  }

  // Fallback / blend: wrist farther from hip than elbow, wrist y near shoulder
  const wristFromHip = dist(fwd.wrist, fwd.hip);
  const elbowFromHip = dist(fwd.elbow, fwd.hip);
  const reachScore = clamp01((wristFromHip - elbowFromHip) / (0.2 * torso));
  const yAlign = 1 - clamp01(Math.abs(fwd.wrist.y - fwd.shoulder.y) / (0.35 * torso));
  const fallback = 0.55 * reachScore + 0.45 * yAlign;

  if (forwardScore < 0.15) {
    forwardScore = fallback;
  } else {
    forwardScore = 0.65 * forwardScore + 0.35 * fallback;
  }

  // Hip palm: from the front the wrist sits in front of the hip landmark,
  // so a hand that feels "on the hip" is often 0.3–0.5 torso away in 2D.
  const hipDist = dist(hipSide.wrist, hipSide.hip) / torso;
  const nearHip = clamp01((0.75 - hipDist) / 0.35);
  const elbowAng = jointAngle(hipSide.shoulder, hipSide.elbow, hipSide.wrist);
  const bent = clamp01((165 - elbowAng) / 45);

  return {
    score: clamp01(0.55 * forwardScore + 0.45 * (0.65 * nearHip + 0.35 * bent)),
  };
}

/** @returns {PoseBreakdown} */
function emptyBreakdown() {
  return { score: 0, knees: 0, hips: 0, stance: 0, arms: 0, legs: "missing" };
}

/**
 * @param {number} prev
 * @param {number} next
 */
function smoothPart(prev, next) {
  return EMA_ALPHA * next + (1 - EMA_ALPHA) * prev;
}

/** @param {Landmark | undefined} p @param {number} [min] */
function visible(p, min = VIS_MIN) {
  return p != null && (p.visibility == null || p.visibility >= min);
}

/** @param {Landmark} a @param {Landmark} b */
function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z ?? 0) + (b.z ?? 0)) / 2 };
}

/** @param {Landmark} a @param {Landmark} b */
function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/** Angle at B in degrees for points A–B–C */
function jointAngle(a, b, c) {
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (mag < 1e-8) return 180;
  return (Math.acos(clamp(dot / mag, -1, 1)) * 180) / Math.PI;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v) {
  return clamp(v, 0, 1);
}

/** MediaPipe pose connections for debug skeleton */
export const POSE_CONNECTIONS = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
];

export { LM };
