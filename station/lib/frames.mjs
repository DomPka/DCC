// Live frames from a camera stream through ffmpeg: HLS (.m3u8), RTSP, HTTP MP4/MJPEG,
// a local file, or a web page / YouTube live link resolved with yt-dlp.
// Reconnects with back-off when the stream drops or stalls.
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

const BACKOFF_S = [2, 5, 10, 30, 60];

export class FrameSource extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.url stream URL or file path
   * @param {number} [o.fps] frames per second to analyse
   * @param {number} [o.maxWidth] frames wider than this are scaled down
   * @param {'auto'|'yt-dlp'|'none'} [o.resolve] how to turn a page link into a stream URL
   * @param {boolean} [o.loopFile] for testing with a file: play it in real time, forever
   * @param {string} [o.urlCommand] shell command printing a fresh stream URL, run on every connect
   */
  constructor(o) {
    super();
    this.o = { fps: 10, maxWidth: 1280, resolve: 'auto', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', ytdlp: 'yt-dlp', stallSeconds: 30, ...o };
    this.proc = null;
    this.stopped = false;
    this.failures = 0;
    this.width = 0;
    this.height = 0;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.watchdog);
    this.proc?.kill('SIGKILL');
  }

  async connect() {
    if (this.stopped) return;
    try {
      const url = await this.resolveUrl(this.o.url);
      const { width, height } = await this.probe(url);
      const scale = Math.min(1, this.o.maxWidth / width);
      this.width = even(width * scale);
      this.height = even(height * scale);
      this.spawnFfmpeg(url);
    } catch (err) {
      this.scheduleRetry(err);
    }
  }

  spawnFfmpeg(url) {
    const o = this.o;
    const w = this.width;
    const h = this.height;
    const frameBytes = w * h * 3;
    const args = ['-hide_banner', '-loglevel', 'error', ...inputArgs(url, o), '-i', url, '-an', '-sn', '-dn',
      '-vf', `fps=${o.fps},scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
    const proc = spawn(o.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    let buf = Buffer.allocUnsafe(frameBytes);
    let filled = 0;
    let lastFrameAt = Date.now();
    // Frames come out at exactly o.fps per second of *stream* time, but HLS delivers them in
    // bursts. Timestamp them on the stream clock, anchored to wall time, so the tracker sees
    // true spacing; re-anchor (and flag a gap) if the stream stalls and falls behind.
    let anchor = null;
    let index = 0;
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      let off = 0;
      while (off < chunk.length) {
        const n = Math.min(frameBytes - filled, chunk.length - off);
        chunk.copy(buf, filled, off, off + n);
        filled += n;
        off += n;
        if (filled === frameBytes) {
          lastFrameAt = Date.now();
          if (this.failures) this.emit('up');
          this.failures = 0;
          let gap = false;
          let t = anchor === null ? lastFrameAt : anchor + (index * 1000) / o.fps;
          if (anchor === null || lastFrameAt - t > 20000 || t - lastFrameAt > 20000) {
            anchor = lastFrameAt;
            index = 0;
            t = lastFrameAt;
            gap = true;
          }
          index++;
          this.emit('frame', { data: buf, width: w, height: h, t, gap });
          buf = Buffer.allocUnsafe(frameBytes);
          filled = 0;
        }
      }
    });
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (Date.now() - lastFrameAt > o.stallSeconds * 1000) {
        this.emit('log', `no frames for ${o.stallSeconds}s, reconnecting`);
        proc.kill('SIGKILL');
      }
    }, 5000);
    proc.on('close', (code) => {
      clearInterval(this.watchdog);
      if (this.proc === proc) this.proc = null;
      if (this.stopped) return;
      this.scheduleRetry(new Error(`ffmpeg exited (${code}) ${stderr.trim().split('\n').pop() || ''}`));
    });
    proc.on('error', (err) => this.scheduleRetry(err));
    this.emit('log', `connected: ${w}x${h} at ${o.fps} fps`);
  }

  scheduleRetry(err) {
    if (this.stopped || this.retryTimer?.pending) return;
    const wait = BACKOFF_S[Math.min(this.failures, BACKOFF_S.length - 1)];
    this.failures++;
    this.emit('down', err);
    this.emit('log', `stream unavailable (${err.message}); retrying in ${wait}s`);
    clearTimeout(this.retryTimer);
    const timer = setTimeout(() => {
      timer.pending = false;
      this.connect();
    }, wait * 1000);
    timer.pending = true;
    this.retryTimer = timer;
  }

  async resolveUrl(url) {
    if (this.o.urlCommand) {
      // custom resolver: any shell command that prints a fresh stream URL (for expiring tokens)
      const out = await run(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', this.o.urlCommand] : ['-c', this.o.urlCommand], 60000);
      const fresh = out.trim().split('\n').pop();
      if (!fresh) throw new Error('urlCommand printed no URL');
      return fresh;
    }
    const mode = this.o.resolve;
    const looksDirect = /\.(m3u8|mp4|mov|mkv|webm|ts|mjpg|mjpeg)(\?|$)/i.test(url) || /^(rtsp|rtmp|srt|udp):/i.test(url) || !/^https?:/i.test(url);
    const isPage = /youtube\.com|youtu\.be|twitch\.tv/i.test(url);
    if (mode === 'none' || (mode === 'auto' && looksDirect && !isPage)) return url;
    if (mode === 'auto' && !isPage) {
      // unknown http link: try it directly first, fall back to yt-dlp
      try {
        await this.probe(url);
        return url;
      } catch {
        /* fall through */
      }
    }
    const out = await run(this.o.ytdlp, ['-g', '-f', 'best[protocol^=m3u8]/best[ext=mp4]/best', '--no-warnings', url], 60000);
    const resolved = out.trim().split('\n')[0];
    if (!resolved) throw new Error('yt-dlp found no stream on that page');
    this.emit('log', 'resolved page link to a stream with yt-dlp');
    return resolved;
  }

  async probe(url) {
    const out = await run(this.o.ffprobe, ['-v', 'error', ...inputArgs(url, this.o, true), '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', url], 45000);
    const m = out.trim().match(/(\d+),(\d+)/);
    if (!m) throw new Error('no video stream found');
    return { width: Number(m[1]), height: Number(m[2]) };
  }
}

function inputArgs(url, o, probe = false) {
  if (/^rtsp:/i.test(url)) return ['-rtsp_transport', 'tcp'];
  if (/^https?:/i.test(url)) return probe ? ['-rw_timeout', '15000000'] : ['-rw_timeout', '15000000', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10'];
  if (o.loopFile && !probe) return ['-re', '-stream_loop', '-1'];
  return [];
}

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.code === 'ENOENT' ? `${cmd} is not installed` : (stderr || err.message).trim().split('\n').pop()));
      else resolve(stdout);
    });
  });
}

function even(v) {
  return Math.max(2, Math.round(v / 2) * 2);
}
