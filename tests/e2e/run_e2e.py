"""
End-to-end check of the web app in headless Chromium (Playwright).

Loads the page, draws a counting line, opens a video, runs the count to the end and
compares the result with the expected numbers. Also saves screenshots and the CSVs.

Usage:
  node tools/serve.mjs 8123 &
  python3 tests/e2e/run_e2e.py --video clip.webm --line 0.5 0.055 0.5 0.945 --expect-in 2 --expect-out 4 \
      [--mode fast|exact] [--webgpu] [--out results_dir]
Line coordinates are normalised (0..1) x1 y1 x2 y2.
"""
import argparse
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://localhost:8123/")
ap.add_argument("--video", required=True)
ap.add_argument("--line", nargs=4, type=float, required=True)
ap.add_argument("--expect-in", type=int, required=True)
ap.add_argument("--expect-out", type=int, required=True)
ap.add_argument("--mode", default="fast", choices=["fast", "exact"])
ap.add_argument("--fps", type=int, default=15, help="analysed frames per second of video")
ap.add_argument("--webgpu", action="store_true", help="enable SwiftShader WebGPU in headless Chromium")
ap.add_argument("--out", default="e2e-results")
ap.add_argument("--timeout", type=float, default=600)
args = ap.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)

flags = ["--autoplay-policy=no-user-gesture-required"]
if args.webgpu:
    flags += ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader"]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=flags)
    ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
    page = ctx.new_page()
    logs = []
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    page.add_init_script(f"localStorage.setItem('cc.settings', JSON.stringify({{mode: '{args.mode}', fps: {args.fps}}}))")

    page.goto(args.url)
    page.wait_for_function("window.__carCounter && window.__carCounter.detector.info", timeout=180_000)
    info = page.evaluate("({...window.__carCounter.detector.info, coi: self.crossOriginIsolated})")
    print("detector:", json.dumps({k: info[k] for k in ("backend", "format", "nc", "warmMs", "coi")}))

    x1, y1, x2, y2 = args.line
    page.evaluate(
        "([x1,y1,x2,y2]) => { window.__carCounter.lines = [{id:'gate', name:'Gate', a:{x:x1,y:y1}, b:{x:x2,y:y2}}]; }",
        [x1, y1, x2, y2],
    )
    page.set_input_files("#file-input", args.video)
    page.wait_for_function("document.querySelector('#btn-run') && !document.querySelector('#btn-run').disabled", timeout=60_000)
    page.click("#btn-edit-done") if page.is_visible("#btn-edit-done") else None
    page.screenshot(path=str(out / "01_ready.png"))

    t0 = time.time()
    page.click("#btn-run")
    shot_taken = False
    while True:
        state = page.evaluate("window.__carCounter.runner.state")
        if state == "done":
            break
        if not shot_taken and page.evaluate("window.__carCounter.counter.totals().total") >= 2:
            page.screenshot(path=str(out / "02_running.png"))
            shot_taken = True
        if time.time() - t0 > args.timeout:
            print("TIMEOUT, state:", state)
            break
        time.sleep(0.25)
    wall = time.time() - t0
    page.screenshot(path=str(out / "03_done.png"))

    res = page.evaluate(
        """() => { const c = window.__carCounter; const l = c.counter.lines[0];
        return { in: l.counts.in, out: l.counts.out, byClass: l.counts.byClass, analysed: c.runner.analysed,
                 duration: document.querySelector('video').duration, events: c.counter.events.length }; }"""
    )
    for btn, name in (("#btn-csv-intervals", "intervals.csv"), ("#btn-csv-events", "events.csv")):
        if page.is_enabled(btn):
            with page.expect_download() as dl:
                page.click(btn)
            dl.value.save_as(str(out / name))

    print(f"result: in={res['in']} out={res['out']} (expected in={args.expect_in} out={args.expect_out}); "
          f"classes={json.dumps(res['byClass'])}")
    print(f"analysed {res['analysed']} frames of a {res['duration']:.1f}s video in {wall:.1f}s wall time "
          f"({res['analysed'] / max(res['duration'], 1e-6):.1f} frames per video second)")
    (out / "console.log").write_text("\n".join(logs))
    errors = [l for l in logs if l.startswith(("[error]", "[pageerror]"))]
    if errors:
        print("console errors:\n  " + "\n  ".join(errors[:10]))
    browser.close()
    ok = res["in"] == args.expect_in and res["out"] == args.expect_out
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
