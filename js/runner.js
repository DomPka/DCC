// Feeds video frames to the detector.
//  live  - camera: always analyse the newest frame, timestamps from the clock
//  fast  - video file: plays muted and adapts the playback speed so that at least
//          `targetFps` frames are analysed per second of video, as fast as the device allows
//  exact - video file: seeks frame by frame at exactly `targetFps`; slower, fully repeatable

export class Runner {
  /**
   * @param {HTMLVideoElement} video
   * @param {(t:number) => Promise<boolean>} analyse runs detection+tracking for the current frame
   */
  constructor(video, analyse) {
    this.video = video;
    this.analyse = analyse;
    this.state = 'idle'; // idle | running | paused | done
    this.mode = 'fast';
    this.targetFps = 15;
    this.rate = 1;
    this.procEma = 0;
    this.analysed = 0;
    this.lastT = null;
    this.videoFrameDt = null;
    this.liveStart = 0;
    this.onState = () => {};
    this.onStats = () => {};
    this.loopToken = 0;
  }

  setMode(mode, targetFps) {
    this.mode = mode;
    this.targetFps = targetFps;
  }

  start() {
    if (this.state === 'running') return;
    this.state = 'running';
    this.onState(this.state);
    const token = ++this.loopToken;
    if (this.mode === 'live') {
      if (!this.liveStart) this.liveStart = performance.now();
      this.loopFrames(token, true);
    } else if (this.mode === 'fast') {
      this.video.muted = true;
      this.video.playbackRate = this.rate;
      this.video.play().catch(() => {});
      this.loopFrames(token, false);
    } else {
      this.video.pause();
      this.loopExact(token);
    }
  }

  pause() {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.loopToken++;
    if (this.mode !== 'live') this.video.pause();
    this.onState(this.state);
  }

  finish() {
    this.state = 'done';
    this.loopToken++;
    if (this.mode !== 'live') this.video.pause();
    this.onState(this.state);
  }

  reset() {
    this.loopToken++;
    this.state = 'idle';
    this.rate = 1;
    this.procEma = 0;
    this.analysed = 0;
    this.lastT = null;
    this.videoFrameDt = null;
    this.liveStart = 0;
    this.speedEma = 0;
    this.statWall = undefined;
  }

  // ---- live camera and fast file mode: analyse whichever frame is current when idle ----
  loopFrames(token, live) {
    const v = this.video;
    let inflight = false;
    let lastMediaTime = null;
    let lastAnalysedMedia = null;
    let guardPaused = false;
    const hasRvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

    const onFrame = (_now, meta) => {
      if (token !== this.loopToken) return;
      const mediaTime = meta ? meta.mediaTime : v.currentTime;
      if (!live && lastMediaTime !== null && mediaTime > lastMediaTime) {
        const dt = mediaTime - lastMediaTime;
        // smallest gap between consecutive presented frames ~ the file's frame interval
        if (dt > 0.004 && (this.videoFrameDt === null || dt < this.videoFrameDt)) this.videoFrameDt = dt;
      }
      lastMediaTime = mediaTime;
      if (!inflight) {
        inflight = true;
        const t = live ? (performance.now() - this.liveStart) / 1000 : mediaTime;
        lastAnalysedMedia = mediaTime;
        const t0 = performance.now();
        this.analyse(t)
          .then((ok) => {
            if (!ok || token !== this.loopToken) return;
            this.analysed++;
            const ms = performance.now() - t0;
            this.procEma = this.procEma ? this.procEma * 0.85 + ms * 0.15 : ms;
            if (!live) this.adaptRate();
            this.reportStats(t);
          })
          .catch((err) => console.error(err))
          .finally(() => {
            inflight = false;
            if (guardPaused && token === this.loopToken && this.state === 'running') {
              guardPaused = false;
              v.play().catch(() => {});
            }
          });
      } else if (!live && lastAnalysedMedia !== null && !v.paused) {
        // Never let the video run much more than one sample interval ahead of the analysis,
        // whatever the rate estimate says (first inference, slow device, thermal throttling).
        const fileFps = this.videoFrameDt ? 1 / this.videoFrameDt : 30;
        const maxGap = 1.2 / Math.min(this.targetFps, fileFps);
        if (mediaTime - lastAnalysedMedia > maxGap) {
          v.pause();
          guardPaused = true;
        }
      }
      schedule();
    };
    const schedule = () => {
      if (token !== this.loopToken) return;
      if (hasRvfc) v.requestVideoFrameCallback(onFrame);
      else requestAnimationFrame(() => onFrame(performance.now(), null));
    };
    if (!live) {
      v.onended = () => {
        if (token === this.loopToken) this.finish();
      };
    }
    schedule();
  }

  adaptRate() {
    const fileFps = this.videoFrameDt ? 1 / this.videoFrameDt : 30;
    const target = Math.min(this.targetFps, fileFps * 0.98);
    const analysisPerWallSec = 1000 / Math.max(1, this.procEma);
    // video seconds per wall second so that analysed frames per video second >= target
    let r = analysisPerWallSec / target;
    r = Math.max(0.0625, Math.min(4, r * 0.9));
    if (Math.abs(r - this.rate) / this.rate > 0.08) {
      this.rate = r;
      try {
        this.video.playbackRate = r;
      } catch {
        /* some browsers clamp very low rates */
      }
    }
  }

  // ---- exact mode: deterministic frame stepping by seeking ----
  async loopExact(token) {
    const v = this.video;
    const step = 1 / this.targetFps;
    const dur = v.duration;
    let t = v.currentTime;
    if (this.lastT !== null && Math.abs(t - this.lastT) < 1e-3) t += step;
    while (token === this.loopToken && t <= dur + 1e-6) {
      await seekTo(v, t);
      if (token !== this.loopToken) return;
      const t0 = performance.now();
      const ok = await this.analyse(v.currentTime);
      if (ok) {
        this.analysed++;
        const ms = performance.now() - t0;
        this.procEma = this.procEma ? this.procEma * 0.85 + ms * 0.15 : ms;
      }
      this.lastT = t;
      this.reportStats(t);
      t += step;
    }
    if (token === this.loopToken) this.finish();
  }

  reportStats(t) {
    const now = performance.now();
    if (this.statWall !== undefined && t > this.statT) {
      const sp = (t - this.statT) / ((now - this.statWall) / 1000);
      this.speedEma = this.speedEma ? this.speedEma * 0.8 + sp * 0.2 : sp;
    }
    this.statT = t;
    this.statWall = now;
    let analysedPerVideoSec;
    if (this.mode === 'live') analysedPerVideoSec = 1000 / Math.max(1, this.procEma);
    else if (this.mode === 'fast') analysedPerVideoSec = 1000 / Math.max(1, this.procEma) / Math.max(0.01, this.speedEma || this.video.playbackRate);
    else analysedPerVideoSec = this.targetFps;
    this.onStats({
      t,
      procMs: this.procEma,
      rate: this.mode === 'fast' ? this.video.playbackRate : 1,
      speedX: this.mode === 'live' ? 1 : this.speedEma || 0,
      analysedPerVideoSec,
      analysed: this.analysed,
    });
  }
}

function seekTo(video, t) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    const onSeeked = () => {
      // wait until the seeked frame is actually decoded and presented
      if ('requestVideoFrameCallback' in video) {
        video.requestVideoFrameCallback(() => done());
        setTimeout(done, 120);
      } else done();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = t;
    setTimeout(done, 4000);
  });
}
