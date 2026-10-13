// Constant-velocity Kalman filter in (cx, cy, aspect, height) space, as in ByteTrack,
// extended to variable time steps so it stays correct when frames are skipped.
// State: [cx, cy, a, h, vcx, vcy, va, vh]; velocities are per "reference frame" (1/30 s).

const SWP = 1 / 20; // std weight position
const SWV = 1 / 160; // std weight velocity
export const REF_FPS = 30;

export function initiate(meas) {
  const [cx, cy, a, h] = meas;
  const mean = new Float64Array([cx, cy, a, h, 0, 0, 0, 0]);
  const std = [2 * SWP * h, 2 * SWP * h, 1e-2, 2 * SWP * h, 10 * SWV * h, 10 * SWV * h, 1e-5, 10 * SWV * h];
  const cov = new Float64Array(64);
  for (let i = 0; i < 8; i++) cov[i * 9] = std[i] * std[i];
  return { mean, cov };
}

/** In-place predict. dtf = elapsed time in reference frames (1.0 at 30 fps). */
export function predict(mean, cov, dtf = 1) {
  const h = mean[3];
  for (let i = 0; i < 4; i++) mean[i] += dtf * mean[i + 4];

  // P' = F P F^T with F = [[I, dt I], [0, I]] written blockwise.
  // P = [[A, B], [B^T, C]] -> A' = A + dt(B + B^T) + dt^2 C, B' = B + dt C, C' = C
  const P = cov;
  const dt = dtf;
  const tmp = new Float64Array(64);
  tmp.set(P);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const A = P[r * 8 + c];
      const B = P[r * 8 + c + 4];
      const Bt = P[(r + 4) * 8 + c];
      const C = P[(r + 4) * 8 + c + 4];
      tmp[r * 8 + c] = A + dt * (B + Bt) + dt * dt * C;
      tmp[r * 8 + c + 4] = B + dt * C;
      tmp[(r + 4) * 8 + c] = Bt + dt * C;
    }
  }
  P.set(tmp);

  const sp = [SWP * h, SWP * h, 1e-2, SWP * h];
  const sv = [SWV * h, SWV * h, 1e-5, SWV * h];
  for (let i = 0; i < 4; i++) {
    P[i * 9] += sp[i] * sp[i] * dtf;
    P[(i + 4) * 9] += sv[i] * sv[i] * dtf;
  }
}

/** In-place measurement update with meas = [cx, cy, a, h]. */
export function update(mean, cov, meas) {
  const h = mean[3];
  const rStd = [SWP * h, SWP * h, 1e-1, SWP * h];

  // S = H P H^T + R  (top-left 4x4 of P)
  const S = new Float64Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) S[r * 4 + c] = cov[r * 8 + c];
  for (let i = 0; i < 4; i++) S[i * 5] += rStd[i] * rStd[i];
  const Si = inv4(S);
  if (!Si) return;

  // K = P H^T S^-1  (8x4) ; P H^T = first 4 columns of P
  const K = new Float64Array(32);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += cov[r * 8 + k] * Si[k * 4 + c];
      K[r * 4 + c] = s;
    }
  }
  const y = [meas[0] - mean[0], meas[1] - mean[1], meas[2] - mean[2], meas[3] - mean[3]];
  for (let r = 0; r < 8; r++) {
    mean[r] += K[r * 4] * y[0] + K[r * 4 + 1] * y[1] + K[r * 4 + 2] * y[2] + K[r * 4 + 3] * y[3];
  }
  // P -= K (H P), where H P = first 4 rows of P
  const HP = cov.slice(0, 32);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += K[r * 4 + k] * HP[k * 8 + c];
      cov[r * 8 + c] -= s;
    }
  }
}

// Gauss-Jordan inverse of a 4x4 matrix; returns null if singular.
function inv4(m) {
  const n = 4;
  const a = new Float64Array(32);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) a[r * 8 + c] = m[r * 4 + c];
    a[r * 8 + 4 + r] = 1;
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r * 8 + col]) > Math.abs(a[piv * 8 + col])) piv = r;
    const pv = a[piv * 8 + col];
    if (Math.abs(pv) < 1e-12) return null;
    if (piv !== col) {
      for (let c = 0; c < 8; c++) {
        const t = a[col * 8 + c];
        a[col * 8 + c] = a[piv * 8 + c];
        a[piv * 8 + c] = t;
      }
    }
    for (let c = 0; c < 8; c++) a[col * 8 + c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r * 8 + col];
      if (f === 0) continue;
      for (let c = 0; c < 8; c++) a[r * 8 + c] -= f * a[col * 8 + c];
    }
  }
  const out = new Float64Array(16);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) out[r * 4 + c] = a[r * 8 + 4 + c];
  return out;
}

export function tlbrToXyah(x1, y1, x2, y2) {
  const w = x2 - x1;
  const h = Math.max(1e-3, y2 - y1);
  return [x1 + w / 2, y1 + h / 2, w / h, h];
}

export function meanToTlbr(mean) {
  const h = mean[3];
  const w = mean[2] * h;
  return [mean[0] - w / 2, mean[1] - h / 2, mean[0] + w / 2, mean[1] + h / 2];
}
