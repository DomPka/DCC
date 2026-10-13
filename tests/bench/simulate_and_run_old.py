"""
Old-vs-new counting benchmark, part 1 (Python).

1. Simulates top-down traffic with known ground truth (cars crossing a counting line),
   including detector noise, missed detections, low-confidence detections and false positives.
2. Runs the ORIGINAL v1 counting logic on it: the repo's own sort.py
   (Sort(max_age=5, min_hits=2, iou_threshold=0.2)) and the "unique track ids whose centre
   lands inside the 20 px tracking box" rule from tracktrack.py / trackingBox.py.
3. Writes scenarios.json for part 2 (run_new.mjs), which runs the new tracker + line counter.

Usage: python3 simulate_and_run_old.py /path/to/old/repo out_dir
"""
import json
import math
import random
import sys
import types
from pathlib import Path

import numpy as np

OLD_REPO = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

# --- load the original sort.py without its GUI-only imports (matplotlib TkAgg, skimage) ---
src = (OLD_REPO / "sort.py").read_text()
src = "\n".join(
    l for l in src.splitlines()
    if not l.startswith(("import matplotlib", "matplotlib.use", "from skimage"))
)
sort_mod = types.ModuleType("sort_v1")
exec(compile(src.split("if __name__ == '__main__':")[0], "sort.py", "exec"), sort_mod.__dict__)
sys.path.insert(0, str(OLD_REPO))
from trackingBox import TrackingBox  # noqa: E402  (original v1 file)

W, H = 1280, 720
LINE = (640, 200, 640, 600)  # x1, y1, x2, y2 of the counting line
SIM_FPS = 30


def simulate(name, seed, duration, lanes, rate, vmin, vmax, miss, noise, low_rate, fp_rate, light=None):
    """Per-lane car-following simulation at 30 fps. Cars never overlap within a lane, keep a
    gap to the car ahead, and (with `light`) queue at a red light whose stop line is the
    counting line, so some cars wait for seconds with their centre right on the line."""
    rng = random.Random(seed)
    dt = 1 / SIM_FPS
    gap = 12
    cars = []
    for lane_y, direction in lanes:
        lane_v = rng.uniform(vmin, vmax)
        t = rng.expovariate(rate)
        while t < duration - 1:
            w = rng.uniform(55, 90)
            cars.append(dict(id=len(cars), lane=lane_y, dir=direction, t0=t, v=lane_v * rng.uniform(0.9, 1.1),
                             w=w, h=w * 0.5, x=None, stop_off=rng.uniform(-30, 10), done=False))
            t += rng.expovariate(rate)
    by_lane = {}
    for c in cars:
        by_lane.setdefault((c["lane"], c["dir"]), []).append(c)

    n = int(duration * SIM_FPS)
    frames = []
    crossings = []
    gt = {"in": 0, "out": 0}
    for f in range(n):
        t = f * dt
        red = bool(light) and (t % light[0]) < light[1]
        for (lane_y, d), lane_cars in by_lane.items():
            leader = None
            for c in lane_cars:  # entry order == driving order
                if c["done"]:
                    continue
                if c["x"] is None:
                    if t < c["t0"]:
                        break
                    spawn = -60 if d > 0 else W + 60
                    if leader is not None and leader["x"] is not None:
                        room = d * (leader["x"] - spawn) - (leader["w"] / 2 + gap + c["w"] / 2)
                        if room < 0:
                            break  # waits off-screen
                    c["x"] = spawn
                # furthest position allowed (in driving direction coordinates)
                pos = d * c["x"]
                limit = pos + c["v"] * dt
                if leader is not None and leader["x"] is not None:
                    limit = min(limit, d * leader["x"] - (leader["w"] / 2 + gap + c["w"] / 2))
                if red and d > 0:
                    stop = LINE[0] + c["stop_off"]
                    if c["x"] <= stop:
                        limit = min(limit, stop)
                new = max(pos, limit)
                old_x = c["x"]
                c["x"] = d * new
                if (old_x - LINE[0]) * (c["x"] - LINE[0]) < 0 or (old_x < LINE[0] <= c["x"]) or (old_x > LINE[0] >= c["x"]):
                    if not c.get("counted"):
                        gt["in" if d < 0 else "out"] += 1
                        c["counted"] = True
                        crossings.append({"car": c["id"], "t": t})
                if c["x"] < -120 or c["x"] > W + 120:
                    c["done"] = True
                leader = c
        dets = []
        for c in cars:
            if c["x"] is None or c["done"]:
                continue
            if rng.random() < miss:
                continue
            x, y = c["x"], c["lane"]
            j = lambda: rng.gauss(0, noise)
            x1, y1, x2, y2 = x - c["w"] / 2 + j(), y - c["h"] / 2 + j(), x + c["w"] / 2 + j(), y + c["h"] / 2 + j()
            if x2 < 0 or x1 > W:
                continue
            score = rng.uniform(0.15, 0.29) if rng.random() < low_rate else rng.uniform(0.5, 0.95)
            dets.append([max(0, x1), y1, min(W, x2), y2, score, 2, c["id"]])
        if rng.random() < fp_rate:
            fx, fy = rng.uniform(0, W), rng.uniform(150, 650)
            dets.append([fx, fy, fx + 50, fy + 25, rng.uniform(0.3, 0.6), 2, -1])
        frames.append({"t": t, "dets": dets})
    gt["total"] = gt["in"] + gt["out"]
    return {"name": name, "frames": frames, "gt": gt, "cars": len(cars), "crossings": crossings}


def old_v1_count(frames, step, conf_thres=0.3):
    """The v1 pipeline: SORT + count unique ids whose box centre is inside the 20 px band."""
    sort_mod.KalmanBoxTracker.count = 0
    tracker = sort_mod.Sort(max_age=5, min_hits=2, iou_threshold=0.2)
    # box built exactly like getLinesMethod.lineGetter.get_box (thickness 20)
    x1, y1, x2, y2 = LINE
    ang = math.atan2(y2 - y1, x2 - x1)
    th = 20
    box = TrackingBox(x1, y1, x2, y2,
                      int(x1 + math.sin(ang) * th), int(y1 - math.cos(ang) * th),
                      int(x2 + math.sin(ang) * th), int(y2 - math.cos(ang) * th), "box0")
    for fr in frames[::step]:
        d = np.array([x[:6] for x in fr["dets"] if x[4] >= conf_thres], dtype=float).reshape(-1, 6)
        if len(d) == 0:  # v1 only called the tracker when there were detections
            continue
        tracked = tracker.update(d, False)
        for row in tracked:
            cx = int(row[0] + (row[2] - row[0]) / 2)
            cy = int(row[1] + (row[3] - row[1]) / 2)
            if box.pointIsInside((cx, cy)):
                box.idList.add(int(row[8]))
    return len(box.idList)


LANES = [(280, 1), (340, 1), (420, -1), (480, -1)]
scenarios = [
    simulate("Free flow", 1, 120, LANES, 0.35, 200, 700, miss=0.08, noise=2.5, low_rate=0.1, fp_rate=0.02),
    simulate("Fast traffic", 2, 120, LANES, 0.35, 600, 1100, miss=0.08, noise=2.5, low_rate=0.1, fp_rate=0.02),
    simulate("Occlusions (25% missed)", 3, 120, LANES, 0.35, 200, 700, miss=0.25, noise=3.5, low_rate=0.15, fp_rate=0.05),
    simulate("Stop & go at the line", 4, 120, LANES, 0.3, 250, 450, miss=0.1, noise=2.5, low_rate=0.1, fp_rate=0.02, light=(14, 7)),
]

results = []
for sc in scenarios:
    for fps in (30, 15, 10, 5):
        step = SIM_FPS // fps
        results.append({"scenario": sc["name"], "fps": fps, "gt": sc["gt"]["total"], "old": old_v1_count(sc["frames"], step)})
        print(results[-1], flush=True)

json.dump({"lineXYXY": LINE, "simFps": SIM_FPS, "scenarios": scenarios}, open(OUT / "scenarios.json", "w"))
json.dump(results, open(OUT / "old_results.json", "w"), indent=1)
