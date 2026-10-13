// ByteTrack-style multi-object tracker (Zhang et al., 2022), written from the paper's
// algorithm with three practical changes for counting vehicles:
//  * time-aware Kalman steps, so skipped/irregular frames don't break motion prediction;
//  * buffered IoU (Yang et al., C-BIoU) in the main association, so small fast objects
//    (drone footage, low analysis fps) still overlap their prediction;
//  * per-track class voting, so a vehicle flickering between "car" and "truck" keeps one class.

import { linearAssignment } from './hungarian.js';
import { initiate, predict, update, tlbrToXyah, meanToTlbr, REF_FPS } from './kalman.js';

const TRACKED = 1;
const LOST = 2;
const REMOVED = 3;

export const DEFAULT_TRACKER_OPTIONS = {
  highThresh: 0.4, // detections at/above this start the first association
  lowThresh: 0.1, // detections between low and high are used to rescue existing tracks
  newTrackThresh: 0.5, // a new track needs a detection at least this confident
  matchThresh: 0.9, // max cost (1 - IoU*score) in the first association
  secondMatchThresh: 0.5,
  unconfirmedMatchThresh: 0.7,
  lostSeconds: 1.5, // how long a lost track can be re-found
  iouBuffer: 0.3, // box expansion (fraction of w/h) for the first association
  maxSpeed: 0.8, // rescue gate for a track's 2nd sighting: box diagonals per 1/30 s
  trailLength: 40,
};

class Track {
  constructor(key, det, t, frame) {
    this.key = key; // internal unique key
    this.id = 0; // display id, assigned on confirmation
    const { mean, cov } = initiate(tlbrToXyah(det[0], det[1], det[2], det[3]));
    this.mean = mean;
    this.cov = cov;
    this.state = TRACKED;
    this.activated = false;
    this.score = det[4];
    this.classVotes = new Map();
    this.vote(det[5], det[4]);
    this.startTime = t;
    this.lastTime = t;
    this.lastFrame = frame;
    this.startFrame = frame;
    this.hits = 1;
    this.trail = [];
    this.box = [det[0], det[1], det[2], det[3]];
    this.firstMeas = tlbrToXyah(det[0], det[1], det[2], det[3]);
  }

  vote(cls, score) {
    this.classVotes.set(cls, (this.classVotes.get(cls) || 0) + score);
    let best = cls;
    let bestV = -1;
    for (const [c, v] of this.classVotes) {
      if (v > bestV) {
        bestV = v;
        best = c;
      }
    }
    this.cls = best;
  }

  predictedBox() {
    return meanToTlbr(this.mean);
  }

  applyDetection(det, t, frame) {
    update(this.mean, this.cov, tlbrToXyah(det[0], det[1], det[2], det[3]));
    this.commonUpdate(det, t, frame);
  }

  /** Second sighting of a new track: start the filter with velocity from the two points,
   *  so prediction is right from frame 3 even when frames are far apart. */
  confirmWith(det, t, frame) {
    const meas = tlbrToXyah(det[0], det[1], det[2], det[3]);
    const dtf = Math.max(1e-3, (t - this.startTime) * REF_FPS);
    const init = initiate(meas);
    this.mean = init.mean;
    this.cov = init.cov;
    for (let i = 0; i < 4; i++) {
      if (i === 2) continue; // aspect ratio velocity stays 0
      this.mean[i + 4] = (meas[i] - this.firstMeas[i]) / dtf;
      const sd = (2 * meas[3]) / 20 / dtf; // two noisy positions -> velocity uncertainty
      this.cov[(i + 4) * 9] = Math.max(this.cov[(i + 4) * 9], sd * sd);
    }
    this.commonUpdate(det, t, frame);
  }

  commonUpdate(det, t, frame) {
    this.score = det[4];
    this.vote(det[5], det[4]);
    this.lastTime = t;
    this.lastFrame = frame;
    this.hits++;
    this.state = TRACKED;
    this.box = meanToTlbr(this.mean);
  }
}

export class ByteTracker {
  constructor(options = {}) {
    this.opt = { ...DEFAULT_TRACKER_OPTIONS, ...options };
    this.reset();
  }

  /** Drop all tracks (e.g. after a seek). Keys stay unique so per-track state elsewhere
   *  never collides; pass full=true to also restart the visible ids at 1. */
  reset(full = true) {
    this.tracked = [];
    this.lost = [];
    this.frame = 0;
    this.lastT = null;
    if (this.nextKey === undefined) this.nextKey = 1;
    if (full || this.nextId === undefined) this.nextId = 1;
  }

  setOptions(o) {
    Object.assign(this.opt, o);
  }

  /**
   * @param {Float32Array|number[]} dets flat [x1,y1,x2,y2,score,cls]*n in pixels
   * @param {number} t timestamp in seconds (video time or wall clock)
   * @returns {Track[]} tracks matched in this frame (check .activated before drawing)
   */
  update(dets, t) {
    const o = this.opt;
    this.frame++;
    const frame = this.frame;
    let dt = this.lastT === null ? 1 / REF_FPS : t - this.lastT;
    if (!(dt > 0)) dt = 1 / REF_FPS;
    this.lastT = t;
    const dtf = Math.min(dt * REF_FPS, 60);

    const high = [];
    const low = [];
    const n = Math.floor(dets.length / 6);
    for (let i = 0; i < n; i++) {
      const d = [dets[i * 6], dets[i * 6 + 1], dets[i * 6 + 2], dets[i * 6 + 3], dets[i * 6 + 4], dets[i * 6 + 5]];
      if (d[4] >= o.highThresh) high.push(d);
      else if (d[4] >= o.lowThresh) low.push(d);
    }

    const unconfirmed = [];
    const confirmed = [];
    for (const tr of this.tracked) (tr.activated ? confirmed : unconfirmed).push(tr);
    const pool = confirmed.concat(this.lost);

    for (const tr of pool) {
      if (tr.state !== TRACKED) tr.mean[7] = 0;
      predict(tr.mean, tr.cov, dtf);
    }
    for (const tr of unconfirmed) predict(tr.mean, tr.cov, dtf);

    const activated = [];
    const refound = [];
    const newlyLost = [];
    const removed = [];

    // 1) confirmed + lost tracks vs high-score detections (buffered IoU, fused with score)
    const m1 = this.associate(pool, high, o.matchThresh, o.iouBuffer, true);
    for (const [ti, di] of m1.matches) {
      const tr = pool[ti];
      const wasLost = tr.state === LOST;
      tr.applyDetection(high[di], t, frame);
      (wasLost ? refound : activated).push(tr);
    }

    // 2) remaining *tracked* tracks vs low-score detections (plain IoU)
    const remaining = m1.unmatchedRows.map((i) => pool[i]).filter((tr) => tr.state === TRACKED);
    const m2 = this.associate(remaining, low, o.secondMatchThresh, 0, false);
    for (const [ti, di] of m2.matches) {
      remaining[ti].applyDetection(low[di], t, frame);
      activated.push(remaining[ti]);
    }
    for (const ti of m2.unmatchedRows) {
      const tr = remaining[ti];
      tr.state = LOST;
      newlyLost.push(tr);
    }

    // 3) unconfirmed tracks (seen once) vs leftover high detections
    const leftHigh = m1.unmatchedCols.map((i) => high[i]);
    const m3 = this.associate(unconfirmed, leftHigh, o.unconfirmedMatchThresh, o.iouBuffer, true);
    const confirm = (tr, det) => {
      tr.confirmWith(det, t, frame);
      tr.activated = true;
      tr.id = this.nextId++;
      activated.push(tr);
    };
    for (const [ti, di] of m3.matches) confirm(unconfirmed[ti], leftHigh[di]);

    // 3b) rescue: a new track's 2nd sighting can be further away than its own size when
    // frames are sparse; link it by centre distance within a speed gate instead.
    const restU = m3.unmatchedRows.map((i) => unconfirmed[i]);
    const restD = m3.unmatchedCols.map((i) => leftHigh[i]);
    const m4 = this.associateByDistance(restU, restD, t);
    for (const [ti, di] of m4.matches) confirm(restU[ti], restD[di]);
    for (const ti of m4.unmatchedRows) {
      restU[ti].state = REMOVED;
      removed.push(restU[ti]);
    }

    // 4) start new tracks
    const born = [];
    for (const di of m4.unmatchedCols) {
      const d = restD[di];
      if (d[4] < o.newTrackThresh) continue;
      const tr = new Track(this.nextKey++, d, t, frame);
      if (frame === 1) {
        tr.activated = true;
        tr.id = this.nextId++;
      }
      born.push(tr);
    }

    // 5) bookkeeping
    const stillLost = [];
    for (const tr of this.lost) {
      if (tr.state === LOST && t - tr.lastTime <= o.lostSeconds) stillLost.push(tr);
      else if (tr.state === LOST) {
        tr.state = REMOVED;
        removed.push(tr);
      }
    }

    let tracked = [];
    const seen = new Set();
    for (const tr of [...activated, ...refound, ...born]) {
      if (tr.state === TRACKED && !seen.has(tr.key)) {
        seen.add(tr.key);
        tracked.push(tr);
      }
    }
    let lost = [];
    for (const tr of [...stillLost, ...newlyLost]) {
      if (tr.state === LOST && !seen.has(tr.key)) {
        seen.add(tr.key);
        lost.push(tr);
      }
    }

    // ByteTrack's remove_duplicate_stracks: a tracked and a lost track on the same object
    const dup = this.removeDuplicates(tracked, lost);
    tracked = dup.tracked;
    lost = dup.lost;

    this.tracked = tracked;
    this.lost = lost;
    this.removedThisFrame = removed;

    for (const tr of tracked) {
      if (tr.lastFrame === frame) {
        const b = tr.box;
        tr.trail.push([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
        if (tr.trail.length > o.trailLength) tr.trail.shift();
      }
    }
    // every track that saw a detection this frame; unconfirmed ones have activated=false
    return tracked.filter((tr) => tr.lastFrame === frame);
  }

  /** All live track keys (tracked + lost), used to prune per-track state elsewhere. */
  liveKeys() {
    const s = new Set();
    for (const tr of this.tracked) s.add(tr.key);
    for (const tr of this.lost) s.add(tr.key);
    return s;
  }

  associate(tracks, dets, thresh, buffer, fuseScore) {
    const nT = tracks.length;
    const nD = dets.length;
    if (nT === 0 || nD === 0) {
      return { matches: [], unmatchedRows: [...Array(nT).keys()], unmatchedCols: [...Array(nD).keys()] };
    }
    const cost = new Float64Array(nT * nD);
    const tb = tracks.map((tr) => tr.predictedBox());
    for (let i = 0; i < nT; i++) {
      for (let j = 0; j < nD; j++) {
        let iou = boxIou(tb[i], dets[j], buffer);
        if (fuseScore) iou *= dets[j][4];
        cost[i * nD + j] = 1 - iou;
      }
    }
    return linearAssignment(cost, nT, nD, thresh);
  }

  associateByDistance(tracks, dets, t) {
    const nT = tracks.length;
    const nD = dets.length;
    if (nT === 0 || nD === 0) {
      return { matches: [], unmatchedRows: [...Array(nT).keys()], unmatchedCols: [...Array(nD).keys()] };
    }
    const cost = new Float64Array(nT * nD).fill(Infinity);
    for (let i = 0; i < nT; i++) {
      const tr = tracks[i];
      const b = tr.box;
      const w = b[2] - b[0];
      const h = b[3] - b[1];
      const diag = Math.hypot(w, h);
      const dtf = Math.max(1, (t - tr.lastTime) * REF_FPS);
      const gate = diag * (0.5 + this.opt.maxSpeed * dtf);
      const area = w * h;
      for (let j = 0; j < nD; j++) {
        const d = dets[j];
        const dArea = (d[2] - d[0]) * (d[3] - d[1]);
        const ratio = dArea / Math.max(1e-6, area);
        if (ratio < 0.4 || ratio > 2.5) continue;
        const dist = Math.hypot((d[0] + d[2]) / 2 - (b[0] + b[2]) / 2, (d[1] + d[3]) / 2 - (b[1] + b[3]) / 2);
        if (dist <= gate) cost[i * nD + j] = dist / gate;
      }
    }
    return linearAssignment(cost, nT, nD, 1);
  }

  removeDuplicates(tracked, lost) {
    if (!tracked.length || !lost.length) return { tracked, lost };
    const dropT = new Set();
    const dropL = new Set();
    for (let i = 0; i < tracked.length; i++) {
      const a = tracked[i];
      const ab = a.predictedBox();
      for (let j = 0; j < lost.length; j++) {
        const b = lost[j];
        if (1 - boxIou(ab, b.predictedBox(), 0) < 0.15) {
          const ageA = a.lastFrame - a.startFrame;
          const ageB = b.lastFrame - b.startFrame;
          if (ageA > ageB) dropL.add(j);
          else dropT.add(i);
        }
      }
    }
    return {
      tracked: tracked.filter((_, i) => !dropT.has(i)),
      lost: lost.filter((_, j) => !dropL.has(j)),
    };
  }
}

/** IoU of two [x1,y1,x2,y2] boxes, each expanded by `buffer` * its own size per side. */
export function boxIou(a, b, buffer = 0) {
  let ax1 = a[0];
  let ay1 = a[1];
  let ax2 = a[2];
  let ay2 = a[3];
  let bx1 = b[0];
  let by1 = b[1];
  let bx2 = b[2];
  let by2 = b[3];
  if (buffer) {
    const aw = (ax2 - ax1) * buffer;
    const ah = (ay2 - ay1) * buffer;
    const bw = (bx2 - bx1) * buffer;
    const bh = (by2 - by1) * buffer;
    ax1 -= aw;
    ax2 += aw;
    ay1 -= ah;
    ay2 += ah;
    bx1 -= bw;
    bx2 += bw;
    by1 -= bh;
    by2 += bh;
  }
  const iw = Math.min(ax2, bx2) - Math.max(ax1, bx1);
  const ih = Math.min(ay2, by2) - Math.max(ay1, by1);
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter;
  return union > 0 ? inter / union : 0;
}
