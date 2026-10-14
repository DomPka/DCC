# DCC: Drone Car Counter

Drone car counter based on YOLO computer vision. Count vehicles crossing lines in drone or camera video, **live on a phone**, **from a video file** or **from an internet camera 24/7**, and see the results by hour, day and weekday.

- **Counter** (`index.html`): runs entirely in the browser, on a phone or computer. Nothing to install; video never leaves the device.
- **Counting station** (`station/`): a small always-on program for a lab PC, Raspberry Pi or server that counts a live camera stream around the clock.
- **Analytics**, on the same page below the counter (and on the station's page): hourly, daily and weekday-by-hour charts, busiest hours, per line, direction and vehicle type, CSV export.

Made by [DomPka](https://github.com/DomPka) (Dominykas Petrulaitis), Aeronautics Laboratory, Antanas Gustaitis' Aviation Institute, VILNIUS TECH.

**Open the app:** [dompka.github.io/DCC](https://dompka.github.io/DCC/) (analytics are further down the same page, or tap *Analytics* in the top bar). On a phone, use *Install as app* (Android) or *Share → Add to Home Screen* (iPhone) and it opens full-screen and works offline.

## What it does

1. Start the phone camera, or open a recorded video (MP4/MOV from a drone works).
2. Tap twice to draw a counting line across the road. Add as many lines as you need and give them names.
3. Press **Start counting**. Each vehicle is counted once per line, in the direction it crossed (*in* / *out*), by type (car, truck, bus, motorcycle, bicycle).
4. Download the results as CSV:
   - **Counts per interval**: one row per 10 s / 30 s / 1 min / 5 min / 15 min with in/out per line, per vehicle type, total and running total.
   - **Every vehicle**: one row per counted crossing with video time, clock time, line, direction, track id and type.

Clock times come from the recording time stored in the MP4/MOV file (read without loading the whole file), or you can type it in.

## Always-on counting from an internet camera

A web page only counts while it's open, so for 24/7 counting run the **station** on any machine that stays on. It pulls the camera stream with FFmpeg, runs the same detector, tracker and line counter as the app, saves hourly counts, and keeps going through stream drops (reconnects with back-off).

**Needs:** Node.js 20+, FFmpeg, and optionally `yt-dlp` (for page links like YouTube live). Runs on Windows, macOS, Linux and 64-bit Raspberry Pi OS.

**Windows, quickest way:** install the two tools once (PowerShell: `winget install OpenJS.NodeJS.LTS Gyan.FFmpeg`), download this repository (Code → Download ZIP) and unzip it, then double-click `station/start-station.bat`. The first time it installs the detector and opens `config.json` in Notepad: put the camera's stream link in `"url"`, save, and double-click the file again. Leave its window open while counting.

**Other systems:**

```bash
cd station
npm install --ignore-scripts          # CPU build of ONNX Runtime is included
cp config.example.json config.json    # set name, stream.url, timezone, password
node station.mjs config.json
```

Open `http://<station address>:8090/` on any phone or computer in the same network: you see the live camera picture with tracked vehicles. Tap **Add line**, tap two points across the road, **Save lines** (asks for the `adminPassword` from the config). Counting on that line starts immediately. The **Analytics** section further down that page shows the station's full history.

**Stream address.** `stream.url` can be an HLS link (`.m3u8`), RTSP, an HTTP MP4/MJPEG stream, or a web page that `yt-dlp` understands. For a news-site camera such as Delfi's *Tiesiogiai iš Geležinio vilko g.*: open the page in desktop Chrome, F12 → Network, filter `m3u8`, start the video, and copy the `.m3u8` link. If that link stops working after a few hours (expiring token), set `stream.urlCommand` to a command that prints a fresh link; the station runs it on every reconnect. Check the camera owner's terms; the station only stores counts, never images.

**See the counts from anywhere (GitHub Pages).** Add a `publish` block to the config with your repository and a fine-grained GitHub token (Contents: read and write, this repository only) in the `GITHUB_TOKEN` environment variable. Every 10 minutes the station writes the hourly counts to the `data` branch (always a single commit, so the repository doesn't grow), and the analytics on `https://dompka.github.io/DCC/` read them automatically.

**Keep it running.** Linux/Raspberry Pi: `station/car-counter-station.service` (systemd, restarts on failure and at boot). Docker: `station/Dockerfile`. Windows: Task Scheduler, "At startup", `node station.mjs config.json`. Measured on a 2.8 GHz server core: about 85 ms per frame with YOLO26n at 640 px, so the default 10 analysed frames per second fit on one core; on slower boards lower `stream.fps` (10 or more keeps counts within a few percent, see the accuracy table).

Data on disk (`station/data/`): `days/YYYY-MM-DD.json` hourly counts per line, direction and vehicle type, plus how many seconds of each hour were actually watched; `events/YYYY-MM-DD.csv` every counted vehicle with its time; `lines.json`.

## Analytics

The **Analytics** section (below the counter, and below the live picture on the station's page) shows, for any period (today, yesterday, last 7 or 30 days, everything, or chosen dates) and any line, direction and vehicle types:

- total vehicles, busiest hour, vehicles per watched hour, in/out split, and how much of the time the camera was watched;
- vehicles by hour of the day (one day, or the average day over the period);
- vehicles per day;
- a typical week: average vehicles per hour for each weekday and hour;
- totals per counting line and direction, and per vehicle type;
- the hourly table, downloadable as CSV.

Every hour also records how long the camera was really watched, so outages show up as gaps instead of looking like quiet traffic; averages count only watched time.

Data sources: the counting station (automatic on the station's own page, or its published GitHub data), counts made in the browser counter on this device (saved automatically when the recording time is known), or a CSV exported from the counter or the station.

## How it works

| Stage | v1 (2023, Python) | v2 (this version, browser) |
|---|---|---|
| Detector | YOLOv7-E6E (152 M parameters) in PyTorch | YOLO26n (2.5 M) or YOLO26s (9.5 M) via ONNX Runtime Web, on the **GPU through WebGPU** where available, otherwise multi-threaded WebAssembly |
| Tracker | SORT, IoU only, tracker skipped on frames with no detections | **ByteTrack**: Kalman filter + two-stage matching that also uses low-confidence detections to keep tracks through blur and partial occlusion |
| Counting rule | Count every track id whose centre is ever inside a 20 px band | **Line crossing**: count when the centre moves from one side of the line to the other within the drawn segment, with direction |
| Speed control | Every frame, as fast as PyTorch runs | Adaptive: plays the file as fast as the device can while still analysing at least 15 frames per video second, or steps frame by frame in Exact mode |
| Runs on | Desktop with Python, FFmpeg, ideally an NVIDIA GPU | Any recent phone or computer browser (Chrome, Edge, Safari, Firefox) |

Changes in the tracker and counter that matter for traffic counts:

- **Time-aware motion model.** The Kalman filter steps by the real time between analysed frames, so skipped frames or a slow phone don't break the motion prediction.
- **Two-point start.** A new track takes its speed from its first two sightings, so a fast car is followed from its third frame on, even when it moves more than its own length between analysed frames.
- **Buffered IoU** (from the C-BIoU tracker) for small, fast vehicles seen from altitude.
- **Hysteresis band** scaled to the vehicle's size: a car waiting at a stop line with its box jittering back and forth is counted once, not every time the box wobbles.
- **Class voting** over a track's life: a van that flickers between *car* and *truck* gets one type.
- **Class-agnostic NMS** so one vehicle detected as both *car* and *truck* doesn't become two tracks.

### Accuracy: v1 vs v2

Simulated top-down traffic with known ground truth (4 lanes, 2 minutes per scenario), detector noise, 8–25 % missed detections, low-confidence detections and false positives. v1 is the original `sort.py` with `Sort(max_age=5, min_hits=2, iou_threshold=0.2)` and the 20 px band rule from `trackingBox.py`; v2 is this repository's tracker and counter, fed the same detections. Reproduce with `tests/bench/` (see below).

| Scenario | Analysed fps | True count | v1 | v2 |
|---|---|---|---|---|
| Free flow | 30 | 164 | 119 (−27.4 %) | 164 (0.0 %) |
| Free flow | 15 | 164 | 98 (−40.2 %) | 164 (0.0 %) |
| Fast traffic | 30 | 168 | 75 (−55.4 %) | 168 (0.0 %) |
| Fast traffic | 15 | 168 | 3 (−98.2 %) | 168 (0.0 %) |
| 25 % of detections missed | 30 | 185 | 86 (−53.5 %) | 185 (0.0 %) |
| 25 % of detections missed | 15 | 185 | 52 (−71.9 %) | 184 (−0.5 %) |
| Stop & go at the line | 30 | 123 | 97 (−21.1 %) | 123 (0.0 %) |
| Stop & go at the line | 15 | 123 | 74 (−39.8 %) | 122 (−0.8 %) |

v1 mainly misses vehicles that move more than 20 px between frames (they jump over the band) and vehicles whose track is hidden for a frame after each missed detection (SORT only reports a track again after two consecutive hits). At 10 analysed frames per second v2 stays within 3.3 %; at 5 it drops to −5…−20 %, which is why the app keeps file analysis at ≥ 15 fps and warns when a live camera falls below 10.

### Speed

Same CPU (2 threads, 640 px input): YOLOv7-E6E 1634 ms per frame in PyTorch; YOLO26n 43 ms per frame in ONNX Runtime, about **38× faster**. Tracking and counting add under 0.1 ms per frame. In the browser the detector uses the graphics chip through WebGPU where the browser supports it (recent Chrome/Edge on Android and desktop, Safari 26), and all CPU cores otherwise.

## Drone footage from straight above

The built-in models are trained on COCO, which is mostly street-level photos. From an oblique drone angle they detect vehicles well; looking **straight down** they often don't (a car seen from above can come out as "cell phone"). For nadir footage, train a model on top-down images and load it in the app:

```bash
pip install ultralytics roboflow
export ROBOFLOW_API_KEY=...   # roboflow.com > Settings > API keys
python training/train_drone_model.py --epochs 100 --imgsz 960
```

This fine-tunes YOLO26n on the lab's Roboflow dataset *cars-from-drone* (bicycle, bus, car, motorcycle, truck) and writes `car-counter-drone.onnx`. A free Google Colab GPU is enough. In the app: **Detection settings → Model → Your own .onnx file**, then set **Detection size** to 960 px. `--visdrone` adds pre-training on the public VisDrone2019 dataset first.

Any detection model exported to ONNX works: YOLOv8/9/11/26 (Ultralytics export), YOLOv5, and YOLOv7 exported with `export.py --grid --simplify` (or `--end2end`). Class names are read from the file when present.

## Run the browser counter locally

```bash
node tools/serve.mjs 8080      # http://localhost:8080 (camera works on localhost)
npm test                       # tracker, counter, assignment, decoding, CSV, station storage tests
node tools/make-demo-data.mjs demo 28   # 4 weeks of sample data: open ./?data=<url>/demo/#analytics
```

Benchmark against v1 (needs the v1 repository checked out, plus `pip install filterpy scipy numpy`):

```bash
python3 tests/bench/simulate_and_run_old.py ../CarCouningVeryImportantPleaseShareLikeAndSubscribe bench-out
node tests/bench/run_new.mjs bench-out
```

End-to-end browser test (Playwright): `python3 tests/e2e/run_e2e.py --video clip.webm --line 0.5 0.05 0.5 0.95 --expect-in 2 --expect-out 4`.

## Project layout

```
index.html, css/app.css      the counter app (no build step, plain ES modules)
js/analytics*.js, charts.js   analytics section shown on the counter and station pages
station.html                 station page: live picture + line setup (js/station-page.js)
station/                     always-on counting station (Node.js, FFmpeg, ONNX Runtime)
js/app.js                    UI, sources (camera, file, stream link), line editing, CSV export
js/sessions.js               browser counting sessions saved for analytics (IndexedDB)
js/runner.js                 frame pacing: live camera, fast and exact file analysis
js/detector.js               main-thread side of the detector
js/detector.worker.js        ONNX Runtime Web inference in a worker (WebGPU / WASM)
js/overlay.js                drawing lines, boxes and trails over the video
js/core/                     pure logic, unit-tested in Node:
  tracker.js  kalman.js  hungarian.js   ByteTrack-style tracker
  counter.js                            line-crossing counter
  postprocess.js                        YOLO output decoding + NMS
  onnxmeta.js  mp4time.js  csv.js       model metadata, video timestamp, CSV
  countdata.js                          hourly count format shared by app, station, analytics
models/                      yolo26n.onnx, yolo26s.onnx (COCO, dynamic input size)
vendor/ort/                  ONNX Runtime Web 1.30 (npm run vendor to update)
vendor/hls/                  hls.js (light build) for live stream links
sw.js, manifest.webmanifest  offline app + install on phone
training/                    script to train a drone-view model
tests/                       unit tests, v1-vs-v2 benchmark, browser end-to-end test
tools/                       local server, demo analytics data, ONNX Runtime vendoring
```

## Licences and credits

- This repository: **AGPL-3.0** (see `LICENSE`), because it ships Ultralytics YOLO26 weights, which are AGPL-3.0. The v1 project was GPL-3.0 (YOLOv7).
- YOLO26 models: Ultralytics, AGPL-3.0.
- ONNX Runtime Web and ONNX Runtime Node: Microsoft, MIT (`vendor/ort/LICENSE`).
- hls.js: Dailymotion, Apache-2.0 (`vendor/hls/LICENSE`).
- Chart colours: a colour-blind-checked categorical palette, validated against this app's surfaces.
- Overpass typeface: Delve Withrington, Red Hat; SIL Open Font License (`fonts/OFL.txt`).
- Algorithms: ByteTrack (Zhang et al., ECCV 2022), C-BIoU (Yang et al., WACV 2023); tracker and counter code written from the papers for this project.
