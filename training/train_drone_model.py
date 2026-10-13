"""
Train a drone-view vehicle detector for Car Counter and export it to ONNX.

Why: the built-in YOLO26 models are trained on COCO (street-level photos). Seen straight
down from a drone, a car often looks like a "cell phone" to them. A model fine-tuned on
top-down footage fixes that. This script fine-tunes YOLO26n on the lab's Roboflow dataset
"cars-from-drone" (5 classes: bicycle, bus, car, motorcycle, truck) and exports an ONNX
file you can load in the app (Detection settings > Model > Your own .onnx file).

Runs best on a GPU, e.g. a free Google Colab T4 (about 20-40 min for 100 epochs).

    pip install ultralytics roboflow
    export ROBOFLOW_API_KEY=...        # roboflow.com > Settings > API keys
    python train_drone_model.py --epochs 100 --imgsz 960

Optional: --visdrone first pre-trains on VisDrone2019 (large public drone dataset, ~2 GB
download, several hours on a T4) and then fine-tunes on the lab dataset.
"""
import argparse
import os
import shutil
from pathlib import Path

from ultralytics import YOLO

ap = argparse.ArgumentParser()
ap.add_argument("--model", default="yolo26n.pt", help="starting weights: yolo26n.pt (fast) or yolo26s.pt (accurate)")
ap.add_argument("--epochs", type=int, default=100)
ap.add_argument("--imgsz", type=int, default=960, help="training size; small cars from altitude like 960-1280")
ap.add_argument("--batch", type=int, default=16)
ap.add_argument("--data", default=None, help="path to an existing data.yaml instead of downloading from Roboflow")
ap.add_argument("--workspace", default="vilniustech-university")
ap.add_argument("--project", default="cars-from-drone-f5kny")
ap.add_argument("--version", type=int, default=1)
ap.add_argument("--visdrone", action="store_true", help="pre-train on VisDrone before fine-tuning")
ap.add_argument("--out", default="car-counter-drone.onnx")
args = ap.parse_args()

data_yaml = args.data
if data_yaml is None:
    from roboflow import Roboflow

    key = os.environ.get("ROBOFLOW_API_KEY")
    if not key:
        raise SystemExit("Set ROBOFLOW_API_KEY or pass --data path/to/data.yaml")
    ds = Roboflow(api_key=key).workspace(args.workspace).project(args.project).version(args.version).download("yolov8")
    data_yaml = str(Path(ds.location) / "data.yaml")

weights = args.model
if args.visdrone:
    pre = YOLO(weights)
    pre.train(data="VisDrone.yaml", epochs=50, imgsz=args.imgsz, batch=args.batch, name="visdrone-pretrain")
    weights = str(Path(pre.trainer.save_dir) / "weights" / "best.pt")

model = YOLO(weights)
model.train(
    data=data_yaml,
    epochs=args.epochs,
    imgsz=args.imgsz,
    batch=args.batch,
    patience=30,
    # top-down footage has no "up": rotations and vertical flips are valid augmentations
    degrees=180,
    flipud=0.5,
    fliplr=0.5,
    mosaic=1.0,
    name="drone-cars",
)
best = Path(model.trainer.save_dir) / "weights" / "best.pt"
print("validation:", YOLO(str(best)).val(data=data_yaml, imgsz=args.imgsz).box.map50)

# Dynamic input size lets the app's "Detection size" setting work; class names are embedded
# in the ONNX metadata, so the app shows them automatically.
onnx_path = YOLO(str(best)).export(format="onnx", dynamic=True, simplify=True, imgsz=args.imgsz)
shutil.copy(onnx_path, args.out)
print(f"\nDone: {args.out}\nIn Car Counter: Detection settings > Model > Your own .onnx file, "
      f"then set Detection size to {args.imgsz} px.")
