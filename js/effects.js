import { LM, POSE_CONNECTIONS } from "./pose.js";

/** @typedef {'idle' | 'charging' | 'active' | 'fading' | 'cooldown'} EffectPhase */

const HOLD_MS = 500;
const INTRO_MS = 700;
const FADE_MS = 2000;
const COOLDOWN_MS = 1000;
const CYAN = "#7ecbff";
const KANJI = "青銀乱残光";

/**
 * Effect state machine + procedural VFX.
 */
export class EffectController {
  constructor() {
    /** @type {EffectPhase} */
    this.phase = "idle";
    /** @type {number} */
    this.opacity = 0;
    /** Scale of each red figure. Intro shrinks into place; exit shrinks away. */
    this.figureScale = 1;
    /** @type {number} */
    this.fadeFromScale = 1;
    /** @type {number} */
    this.fadeFromOpacity = 1;
    /** @type {number} */
    this.phaseStart = 0;
    /** @type {number} */
    this.time = 0;

    this.reduceMotion =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    /** @type {{ x: number, y: number, len: number, speed: number, color: string }[]} */
    this.rain = [];
    /** @type {{ x: number, y: number, size: number, vx: number, vy: number, rot: number }[]} */
    this.particles = [];
    /** @type {{ landmarks: import('./pose.js').Landmark[], age: number }[]} */
    this.trail = [];
    /** @type {{ x: number, tilt: number, width: number, glow: number, alpha: number }[]} */
    this.beams = [];

    this._seedRain(this.reduceMotion ? 12 : 60);
    this._seedParticles(this.reduceMotion ? 8 : 28);
    this._seedBeams(18);

    /** @type {{ ox: number, oy: number, dw: number, dh: number }} */
    this.cover = { ox: 0, oy: 0, dw: 1, dh: 1 };
    this.viewW = 1;
    this.viewH = 1;
    /** @type {CanvasImageSource | null} */
    this.mask = null;
    /** @type {{ x0: number, y0: number, x1: number, y1: number, width: number, height: number } | null} */
    this.maskBox = null;
    /** Last squat cutout, kept so standing up cannot drag the clones sideways. */
    /** @type {HTMLCanvasElement | null} */
    this.posePlate = null;
    /** @type {number} */
    this.poseSpan = 0;
    /** @type {{ x: number, y: number, ry: number } | null} */
    this.poseAnchor = null;
    /** Settled compass size, so detection flicker cannot resize the plate. */
    this.plateRadius = 0;
    this.plateLock = 0;
    this.plateSamples = 0;
  }

  /**
   * @param {boolean} aboveThreshold
   * @param {number} now
   */
  update(aboveThreshold, now) {
    this.time = now;
    const elapsed = now - this.phaseStart;

    switch (this.phase) {
      case "idle":
        this.opacity = 0;
        this.figureScale = 1;
        this.poseSpan = 0;
        this.poseAnchor = null;
        this.plateRadius = 0;
        this.plateLock = 0;
        this.plateSamples = 0;
        if (aboveThreshold) this._enter("charging", now);
        break;

      case "charging":
        this.opacity = 0;
        if (!aboveThreshold) {
          this._enter("idle", now);
        } else if (elapsed >= HOLD_MS) {
          this._enter("active", now);
        }
        break;

      case "active": {
        const intro = Math.min(1, elapsed / INTRO_MS);
        const eased = easeOutCubic(intro);
        this.opacity = eased;
        this.figureScale = lerp(1.32, 1, eased);
        if (!aboveThreshold) this._enter("fading", now);
        break;
      }

      case "fading": {
        const t = Math.min(1, elapsed / FADE_MS);
        const eased = easeOutCubic(t);
        this.opacity = this.fadeFromOpacity * (1 - eased);
        this.figureScale = lerp(this.fadeFromScale, 0.16, eased);
        if (t >= 1) this._enter("cooldown", now);
        break;
      }

      case "cooldown":
        this.opacity = 0;
        if (elapsed >= COOLDOWN_MS) {
          this._enter("idle", now);
          if (aboveThreshold) this._enter("charging", now);
        }
        break;
    }

    if (this.opacity > 0.01 && !this.reduceMotion) {
      this._stepRain();
      this._stepParticles();
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} width
   * @param {number} height
   * @param {import('./pose.js').Landmark[] | undefined} landmarks
   * @param {{ debug?: boolean, score?: number, breakdown?: { knees: number, hips: number, stance: number, arms: number, legs: string }, mask?: CanvasImageSource | null, maskBox?: { x0: number, y0: number, x1: number, y1: number, width: number, height: number } | null, cover?: { ox: number, oy: number, dw: number, dh: number } }} [opts]
   */
  draw(ctx, width, height, landmarks, opts = {}) {
    this.viewW = width;
    this.viewH = height;
    this.cover = opts.cover ?? { ox: 0, oy: 0, dw: width, dh: height };
    this.mask = opts.mask ?? null;
    this.maskBox = opts.maskBox ?? null;
    ctx.clearRect(0, 0, width, height);

    if (this.opacity > 0.01 && landmarks?.length) {
      const alpha = this.opacity;

      this._drawAtmosphere(ctx, width, height, landmarks, alpha);
      this._drawCompass(ctx, width, height, landmarks, alpha);
      this._drawClones(ctx, width, height, landmarks, alpha);
      if (!this.reduceMotion) {
        this._drawRain(ctx, width, height, alpha);
        this._drawParticles(ctx, width, height, alpha);
      }
      this._drawKanji(ctx, width, height, alpha);
    }

    if (opts.debug) {
      this._drawDebug(ctx, width, height, landmarks, opts.score ?? 0, opts.breakdown);
    }
  }

  /** @param {EffectPhase} phase @param {number} now */
  _enter(phase, now) {
    if (phase === "fading") {
      this.fadeFromScale = this.figureScale || 1;
      this.fadeFromOpacity = this.opacity > 0.01 ? this.opacity : 1;
    }
    this.phase = phase;
    this.phaseStart = now;
  }

  _seedRain(n) {
    const colors = ["#7ecbff", "#e8f4ff", "#ff5555"];
    this.rain = Array.from({ length: n }, () => ({
      x: Math.random(),
      y: Math.random(),
      len: 0.04 + Math.random() * 0.1,
      speed: 0.012 + Math.random() * 0.025,
      color: colors[(Math.random() * colors.length) | 0],
    }));
  }

  _seedParticles(n) {
    this.particles = Array.from({ length: n }, () => this._newParticle());
  }

  /** Full-height light beams, spaced unevenly so they don't look like a grid. */
  _seedBeams(n) {
    this.beams = Array.from({ length: n }, (_, i) => {
      const bright = i % 5 === 0;
      return {
        x: (i + 0.2 + Math.random() * 0.6) / n,
        tilt: (Math.random() - 0.5) * 0.035,
        width: bright ? 2.4 : 0.7 + Math.random() * 1.6,
        glow: bright ? 18 : 5 + Math.random() * 12,
        alpha: bright ? 0.5 + Math.random() * 0.35 : 0.14 + Math.random() * 0.22,
      };
    });
  }

  _newParticle() {
    return {
      x: 0.2 + Math.random() * 0.6,
      y: 0.4 + Math.random() * 0.55,
      size: 3 + Math.random() * 6,
      vx: (Math.random() - 0.5) * 0.004,
      vy: -0.002 - Math.random() * 0.006,
      rot: Math.random() * Math.PI,
    };
  }

  _stepRain() {
    for (const drop of this.rain) {
      drop.y += drop.speed;
      if (drop.y > 1.1) {
        drop.y = -drop.len;
        drop.x = Math.random();
      }
    }
  }

  _stepParticles() {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.rot += 0.04;
      if (p.y < -0.05 || p.x < -0.05 || p.x > 1.05) {
        this.particles[i] = this._newParticle();
        this.particles[i].y = 0.85 + Math.random() * 0.15;
      }
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   * @param {number} alpha
   */
  /**
   * Dark-blue vignette, vertical white beams, then a soft hole so the
   * person (the video under the canvas) stays lit.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   * @param {import('./pose.js').Landmark[]} lm
   * @param {number} alpha
   */
  _drawAtmosphere(ctx, w, h, lm, alpha) {
    const bounds = this._bodyBounds(lm, w, h);
    const cx = bounds ? bounds.cx : w / 2;
    const cy = bounds ? bounds.cy : h / 2;

    ctx.save();
    const vignette = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.08, cx, cy, Math.max(w, h) * 0.72);
    vignette.addColorStop(0, `rgba(16, 36, 88, ${0.28 * alpha})`);
    vignette.addColorStop(0.45, `rgba(7, 14, 46, ${0.72 * alpha})`);
    vignette.addColorStop(1, `rgba(1, 3, 14, ${0.9 * alpha})`);
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);

    const flicker = this.reduceMotion ? 1 : 0.85 + 0.15 * Math.sin(this.time * 0.004);
    for (const beam of this.beams) {
      const x = beam.x * w;
      ctx.strokeStyle = `rgba(255, 255, 255, ${beam.alpha * alpha * flicker})`;
      ctx.shadowColor = "rgba(214, 232, 255, 0.95)";
      ctx.shadowBlur = beam.glow;
      ctx.lineWidth = beam.width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + beam.tilt * h, h);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    if (this.mask) {
      this._drawMask(ctx, this.mask, 0, 0, 1, 16);
    } else if (bounds) {
      ctx.translate(bounds.cx, bounds.cy);
      ctx.scale(bounds.rx, bounds.ry);
      const hole = ctx.createRadialGradient(0, 0, 0.15, 0, 0, 1.35);
      hole.addColorStop(0, "rgba(0, 0, 0, 1)");
      hole.addColorStop(0.55, "rgba(0, 0, 0, 0.96)");
      hole.addColorStop(0.82, "rgba(0, 0, 0, 0.45)");
      hole.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = hole;
      ctx.beginPath();
      ctx.arc(0, 0, 1.35, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Draw the person cutout where the mirrored camera image sits.
   * dx/dy are screen pixels after that mirror.
   * @param {CanvasRenderingContext2D} ctx
   * @param {CanvasImageSource} source
   */
  /**
   * @param {number} [scale]
   * @param {{ x: number, y: number } | null} [anchor] screen-space body center before dx/dy
   */
  _drawMask(ctx, source, dx, dy, alpha, blur, scale = 1, anchor = null) {
    const { ox, oy, dw, dh } = this.cover;
    const ax = (anchor?.x ?? this.viewW / 2) + dx;
    const ay = (anchor?.y ?? this.viewH / 2) + dy;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (blur > 0.5) ctx.filter = `blur(${blur}px)`;
    if (scale !== 1) {
      ctx.translate(ax, ay);
      ctx.scale(scale, scale);
      ctx.translate(-ax, -ay);
    }
    ctx.translate(dx, dy);
    ctx.translate(this.viewW, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(source, ox, oy, dw, dh);
    ctx.restore();
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   * @param {import('./pose.js').Landmark[]} lm
   * @param {number} alpha
   */
  _drawCompass(ctx, w, h, lm, alpha) {
    const la = this._pt(lm, LM.LEFT_ANKLE, w, h);
    const ra = this._pt(lm, LM.RIGHT_ANKLE, w, h);
    const ls = this._pt(lm, LM.LEFT_SHOULDER, w, h);
    const rs = this._pt(lm, LM.RIGHT_SHOULDER, w, h);
    if (!la || !ra || !ls || !rs) return;

    const bodyW = this._bodyWidth(lm, w, h);
    const span = this.poseSpan || this._cutoutWidth(lm, w, h);
    // A floor disc a little wider than the silhouette. Squash Y so the
    // ring lies on the floor instead of standing up as a coin.
    const radius = this._steadyPlate(Math.max(bodyW * 1.55, span * 0.78));
    const cx = (la.x + ra.x) / 2;
    const cy = (la.y + ra.y) / 2 + bodyW * 0.06;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, 0.46);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = CYAN;
    ctx.fillStyle = CYAN;
    ctx.shadowColor = "rgba(170, 220, 255, 0.95)";

    ctx.globalAlpha = 0.22 * alpha;
    ctx.shadowBlur = 48;
    ctx.fillStyle = "rgba(90, 170, 255, 1)";
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.92, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = alpha;
    ctx.shadowBlur = 16;
    ctx.fillStyle = CYAN;
    ctx.lineWidth = Math.max(2.5, bodyW * 0.016);
    for (const r of [1, 0.9]) {
      ctx.beginPath();
      ctx.arc(0, 0, radius * r, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.lineWidth = Math.max(1.5, bodyW * 0.008);
    for (const r of [0.62, 0.3]) {
      ctx.beginPath();
      ctx.arc(0, 0, radius * r, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * radius * 0.3, Math.sin(a) * radius * 0.3);
      ctx.lineTo(Math.cos(a) * radius * 0.98, Math.sin(a) * radius * 0.98);
      ctx.stroke();
    }

    ctx.lineWidth = Math.max(1.25, bodyW * 0.006);
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      const inner = radius * (i % 5 === 0 ? 0.9 : 0.945);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
      ctx.lineTo(Math.cos(a) * radius * 1.03, Math.sin(a) * radius * 1.03);
      ctx.stroke();
    }

    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
      const len = i === 0 ? radius * 0.94 : radius * 0.58;
      const spread = i === 0 ? 0.18 : 0.11;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * len, Math.sin(a) * len);
      ctx.lineTo(Math.cos(a + spread) * radius * 0.2, Math.sin(a + spread) * radius * 0.2);
      ctx.lineTo(Math.cos(a - spread) * radius * 0.2, Math.sin(a - spread) * radius * 0.2);
      ctx.closePath();
      ctx.globalAlpha = (i === 0 ? 0.9 : 0.4) * alpha;
      ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.stroke();
    }

    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
      const r = radius * 0.1;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * Hold the compass near the size it settled on. Live detection can
   * swing widely; the drawn plate only breathes inside a small band.
   * @param {number} raw
   */
  _steadyPlate(raw) {
    if (!(raw > 0)) return this.plateRadius || 0;
    if (this.phase === "fading" && this.plateRadius > 0) return this.plateRadius;
    if (!this.plateRadius) {
      this.plateRadius = raw;
      this.plateLock = raw;
      this.plateSamples = 1;
      return raw;
    }
    if (this.plateSamples < 18) {
      this.plateSamples += 1;
      this.plateLock += (raw - this.plateLock) / this.plateSamples;
      this.plateRadius = this.plateLock;
      return this.plateRadius;
    }
    const clamped = Math.max(this.plateLock * 0.94, Math.min(this.plateLock * 1.06, raw));
    this.plateRadius += (clamped - this.plateRadius) * 0.08;
    return this.plateRadius;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   * @param {import('./pose.js').Landmark[]} lm
   * @param {number} alpha
   */
  _drawClones(ctx, w, h, lm, alpha) {
    const leaving = this.phase === "fading" && this.posePlate && this.poseAnchor;
    const source = leaving ? this.posePlate : this.mask;
    if (!source) return;

    if (!leaving) this._stashCutout(lm, w, h);
    const span = this.poseSpan || this._cutoutWidth(lm, w, h);
    const anchor = this.poseAnchor;
    const scale = this.figureScale;
    // One offset, shared by a thin halo and a sharp cutout, so the
    // silhouette stays readable instead of smearing into a red mass.
    const dist = 0.58;
    const layers = [
      { dist, blur: 8, a: 0.32 },
      { dist, blur: 0, a: 0.9 },
    ];

    for (const side of [-1, 1]) {
      for (const layer of layers) {
        this._drawMask(
          ctx,
          source,
          side * span * layer.dist,
          0,
          alpha * layer.a,
          layer.blur,
          scale,
          anchor
        );
      }
      this._drawCloneEnergy(
        ctx,
        w,
        h,
        lm,
        side * span * dist,
        alpha * 0.4,
        span * 0.5,
        scale,
        anchor
      );
    }
  }

  /**
   * Remember the squat silhouette. Width only creeps, so a stand-up
   * cannot fling the copies outward before the fade starts.
   * @param {import('./pose.js').Landmark[]} lm
   */
  _stashCutout(lm, w, h) {
    if (this.mask && this.phase === "active") {
      const src = /** @type {HTMLCanvasElement} */ (this.mask);
      const sw = src.width;
      const sh = src.height;
      if (sw && sh) {
        if (!this.posePlate) this.posePlate = document.createElement("canvas");
        if (this.posePlate.width !== sw || this.posePlate.height !== sh) {
          this.posePlate.width = sw;
          this.posePlate.height = sh;
        }
        const plate = this.posePlate.getContext("2d");
        plate?.clearRect(0, 0, sw, sh);
        plate?.drawImage(src, 0, 0);
      }
    }

    const live = this._cutoutWidth(lm, w, h);
    if (!this.poseSpan) {
      this.poseSpan = live;
    } else {
      const step = Math.max(1.2, this.poseSpan * 0.004);
      const delta = Math.max(-step, Math.min(step, live - this.poseSpan));
      this.poseSpan += delta;
    }

    const bounds = this._bodyBounds(lm, w, h);
    if (bounds) this.poseAnchor = { x: bounds.cx, y: bounds.cy, ry: bounds.ry };
  }

  /**
   * Screen width of the segmented person. Falls back to a pose estimate.
   * @param {import('./pose.js').Landmark[]} lm
   */
  _cutoutWidth(lm, w, h) {
    const box = this.maskBox;
    if (box && box.width > 0) {
      const frac = (box.x1 - box.x0) / box.width;
      if (frac > 0.04 && frac < 0.9) return frac * this.cover.dw;
    }
    return this._bodyWidth(lm, w, h) * 2.4;
  }

  /**
   * Short streaks and sparks around a flank figure.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} [scale]
   * @param {{ x: number, y: number, ry: number } | null} [anchor]
   */
  _drawCloneEnergy(ctx, w, h, lm, ox, alpha, bodyW, scale = 1, anchor = null) {
    const bounds = anchor
      ? { cx: anchor.x, cy: anchor.y, ry: anchor.ry }
      : this._bodyBounds(lm, w, h);
    if (!bounds) return;
    const top = bounds.cy - bounds.ry;
    const span = bounds.ry * 2;
    const t = this.reduceMotion ? 0 : this.time * 0.003;
    const px = bounds.cx + ox;
    const py = bounds.cy;

    ctx.save();
    ctx.translate(px, py);
    ctx.scale(scale, scale);
    ctx.translate(-px, -py);
    ctx.translate(ox, 0);
    ctx.globalAlpha = alpha;
    ctx.lineCap = "round";
    for (let i = 0; i < 8; i++) {
      const edge = Math.sin(i * 2.17 + t) >= 0 ? 1 : -1;
      const x = bounds.cx + edge * (bodyW + 6);
      const y = top + ((i * 0.173 + t * 0.11) % 1) * span;
      const len = 7 + (i % 3) * 4;
      const hot = i % 3 === 0;
      ctx.strokeStyle = hot ? "rgba(255, 255, 255, 0.85)" : "rgba(255, 170, 180, 0.55)";
      ctx.shadowColor = "rgba(255, 60, 80, 0.8)";
      ctx.shadowBlur = hot ? 6 : 3;
      ctx.lineWidth = hot ? 1.4 : 0.8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.sin(i + t) * 4, y + len);
      ctx.stroke();

      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      ctx.beginPath();
      ctx.arc(x, y, hot ? 2.6 : 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * @param {import('./pose.js').Landmark[]} lm
   */
  _bodyWidth(lm, w, h) {
    const ls = this._pt(lm, LM.LEFT_SHOULDER, w, h);
    const rs = this._pt(lm, LM.RIGHT_SHOULDER, w, h);
    const lh = this._pt(lm, LM.LEFT_HIP, w, h);
    const rh = this._pt(lm, LM.RIGHT_HIP, w, h);
    const shoulder = ls && rs ? dist2(ls, rs) : 0;
    const hip = lh && rh ? dist2(lh, rh) : 0;
    return Math.max(shoulder, hip, Math.min(w, h) * 0.12);
  }

  /**
   * @param {import('./pose.js').Landmark[]} lm
   * @returns {{ cx: number, cy: number, rx: number, ry: number } | null}
   */
  _bodyBounds(lm, w, h) {
    const ids = [
      LM.LEFT_SHOULDER,
      LM.RIGHT_SHOULDER,
      LM.LEFT_ELBOW,
      LM.RIGHT_ELBOW,
      LM.LEFT_WRIST,
      LM.RIGHT_WRIST,
      LM.LEFT_HIP,
      LM.RIGHT_HIP,
      LM.LEFT_KNEE,
      LM.RIGHT_KNEE,
      LM.LEFT_ANKLE,
      LM.RIGHT_ANKLE,
    ];
    /** @type {{ x: number, y: number }[]} */
    const pts = [];
    for (const id of ids) {
      const p = this._pt(lm, id, w, h);
      if (p) pts.push(p);
    }
    const ls = this._pt(lm, LM.LEFT_SHOULDER, w, h);
    const rs = this._pt(lm, LM.RIGHT_SHOULDER, w, h);
    if (ls && rs) {
      const headR = dist2(ls, rs) * 0.7;
      pts.push({ x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 - headR * 1.6 });
    }
    if (pts.length < 4) return null;

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const bodyW = Math.max(40, maxX - minX);
    return {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      rx: bodyW * 0.72,
      ry: Math.max(40, (maxY - minY) * 0.62),
    };
  }

  /**
   * @param {import('./pose.js').Landmark[]} lm
   * @param {number} index
   */
  _pt(lm, index, _w, _h) {
    const p = lm[index];
    if (!p) return null;
    const { ox, oy, dw, dh } = this.cover;
    return { x: ox + (1 - p.x) * dw, y: oy + p.y * dh };
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   * @param {number} alpha
   */
  _drawRain(ctx, w, h, alpha) {
    ctx.save();
    ctx.globalAlpha = 0.75 * alpha;
    ctx.lineWidth = 1.25;
    ctx.shadowBlur = 6;
    for (const drop of this.rain) {
      const x = drop.x * w;
      const y0 = drop.y * h;
      const y1 = (drop.y + drop.len) * h;
      ctx.strokeStyle = drop.color;
      ctx.shadowColor = drop.color;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   * @param {number} alpha
   */
  _drawParticles(ctx, w, h, alpha) {
    ctx.save();
    ctx.fillStyle = "rgba(232, 244, 255, 0.9)";
    ctx.shadowColor = "rgba(154, 216, 255, 0.9)";
    ctx.shadowBlur = 8;
    ctx.globalAlpha = alpha;
    for (const p of this.particles) {
      const cx = p.x * w;
      const cy = p.y * h;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(p.rot);
      ctx.beginPath();
      ctx.moveTo(0, -p.size);
      ctx.lineTo(p.size * 0.65, 0);
      ctx.lineTo(0, p.size);
      ctx.lineTo(-p.size * 0.65, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   * @param {number} alpha
   */
  _drawKanji(ctx, w, h, alpha) {
    ctx.save();
    const size = Math.min(w, h) * 0.085;
    ctx.font = `700 ${size}px "Hiragino Mincho ProN", "Yu Mincho", "Songti SC", serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#9ad8ff";
    ctx.shadowColor = "rgba(255, 255, 255, 0.95)";
    ctx.shadowBlur = 22;
    ctx.fillText(KANJI, w / 2, h * 0.06);
    ctx.shadowBlur = 8;
    ctx.fillText(KANJI, w / 2, h * 0.06);
    ctx.restore();
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   * @param {import('./pose.js').Landmark[] | undefined} lm
   * @param {number} score
   * @param {{ knees: number, hips: number, stance: number, arms: number, legs: string } | undefined} [parts]
   */
  _drawDebug(ctx, w, h, lm, score, parts) {
    ctx.save();
    if (lm?.length) {
      ctx.strokeStyle = "rgba(0, 255, 160, 0.85)";
      ctx.fillStyle = "rgba(0, 255, 160, 0.9)";
      ctx.lineWidth = 2;
      ctx.shadowBlur = 0;

      for (const [a, b] of POSE_CONNECTIONS) {
        const pa = lm[a];
        const pb = lm[b];
        if (!pa || !pb) continue;
        ctx.beginPath();
        ctx.moveTo((1 - pa.x) * w, pa.y * h);
        ctx.lineTo((1 - pb.x) * w, pb.y * h);
        ctx.stroke();
      }

      for (const p of lm) {
        if (!p) continue;
        ctx.beginPath();
        ctx.arc((1 - p.x) * w, p.y * h, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const fontSize = Math.max(26, Math.min(w, h) * 0.038);
    const pad = fontSize * 0.55;
    const line = fontSize * 1.35;
    const lines = parts
      ? [
          `score: ${score.toFixed(3)}`,
          parts.legs === "missing"
            ? "knees: not in frame"
            : `knees: ${parts.knees.toFixed(2)}${parts.legs === "partial" ? " (1 leg)" : ""}`,
          `hips:  ${parts.hips.toFixed(2)}`,
          `feet:  ${parts.stance.toFixed(2)}`,
          `arms:  ${parts.arms.toFixed(2)}`,
          `state: ${this.phase}`,
        ]
      : [
          `score: ${score.toFixed(3)}`,
          `state: ${this.phase}`,
          `opacity: ${this.opacity.toFixed(2)}`,
        ];
    const boxW = fontSize * 14;
    const boxH = pad * 2 + line * lines.length;
    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.fillRect(pad, pad, boxW, boxH);
    ctx.font = `700 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const x = pad * 1.6;
    let y = pad * 1.4;
    for (const text of lines) {
      ctx.fillStyle = text.includes("not in frame") ? "#ffd27a" : "#9effc8";
      ctx.fillText(text, x, y);
      y += line;
    }
    ctx.restore();
  }
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** @param {number} a @param {number} b @param {number} t */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
