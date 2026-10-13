# Car Counter 2

Count vehicles crossing lines in drone or camera video, **live on a phone** or **from a video file**, entirely in the browser. Nothing to install, no Python, no GPU drivers; video never leaves the device.

Made by [DomPka](https://github.com/DomPka) (Dominykas Petrulaitis), Aeronautics Laboratory, Antanas Gustaitis' Aviation Institute, VILNIUS TECH.

**Open the app:** `https://dompka.github.io/<repository-name>/` (after enabling GitHub Pages, see below). On a phone, use *Install as app* (Android) or *Share → Add to Home Screen* (iPhone) and it opens full-screen and works offline.

## What it does

1. Start the phone camera, or open a recorded video (MP4/MOV from a drone works).
2. Tap twice to draw a counting line across the road. Add as many lines as you need and give them names.
3. Press **Start counting**. Each vehicle is counted once per line, in the direction it crossed (*in* / *out*), by type (car, truck, bus, motorcycle, bicycle).
4. Download the results as CSV:
   - **Counts per interval**: one row per 10 s / 30 s / 1 min / 5 min / 15 min with in/out per line, per vehicle type, total and running total.
   - **Every vehicle**: one row per counted crossing with video time, clock time, line, direction, track id and type.

Clock times come from the recording time stored in the MP4/MOV file (read without loading the whole file), or you can type it in.

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

## Publish on GitHub Pages

1. Push this folder to a GitHub repository.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Open `https://<user>.github.io/<repository>/`.

GitHub Pages cannot send the cross-origin isolation headers that multi-threaded WebAssembly needs, so `sw.js` adds them; the page reloads itself once on the very first visit to switch them on. When you change app files, bump `VERSION` in `sw.js` so installed copies update.

## Run locally

```bash
node tools/serve.mjs 8080      # http://localhost:8080 (camera works on localhost)
npm test                       # tracker, counter, assignment, decoding, CSV unit tests
```

Benchmark against v1 (needs the v1 repository checked out, plus `pip install filterpy scipy numpy`):

```bash
python3 tests/bench/simulate_and_run_old.py ../CarCouningVeryImportantPleaseShareLikeAndSubscribe bench-out
node tests/bench/run_new.mjs bench-out
```

End-to-end browser test (Playwright): `python3 tests/e2e/run_e2e.py --video clip.webm --line 0.5 0.05 0.5 0.95 --expect-in 2 --expect-out 4`.

## Project layout

```
index.html, css/app.css      the app page (no build step, plain ES modules)
js/app.js                    UI, sources, line editing, CSV export
js/runner.js                 frame pacing: live camera, fast and exact file analysis
js/detector.js               main-thread side of the detector
js/detector.worker.js        ONNX Runtime Web inference in a worker (WebGPU / WASM)
js/overlay.js                drawing lines, boxes and trails over the video
js/core/                     pure logic, unit-tested in Node:
  tracker.js  kalman.js  hungarian.js   ByteTrack-style tracker
  counter.js                            line-crossing counter
  postprocess.js                        YOLO output decoding + NMS
  onnxmeta.js  mp4time.js  csv.js       model metadata, video timestamp, CSV
models/                      yolo26n.onnx, yolo26s.onnx (COCO, dynamic input size)
vendor/ort/                  ONNX Runtime Web 1.30 (npm run vendor to update)
sw.js, manifest.webmanifest  offline app + install on phone
training/                    script to train a drone-view model
tests/                       unit tests, v1-vs-v2 benchmark, browser end-to-end test
```

## Licences and credits

- This repository: **AGPL-3.0** (see `LICENSE`), because it ships Ultralytics YOLO26 weights, which are AGPL-3.0. The v1 project was GPL-3.0 (YOLOv7).
- YOLO26 models: Ultralytics, AGPL-3.0.
- ONNX Runtime Web: Microsoft, MIT (`vendor/ort/LICENSE`).
- Overpass typeface: Delve Withrington, Red Hat; SIL Open Font License (`fonts/OFL.txt`).
- Algorithms: ByteTrack (Zhang et al., ECCV 2022), C-BIoU (Yang et al., WACV 2023); tracker and counter code written from the papers for this project.
