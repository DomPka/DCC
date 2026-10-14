#!/bin/sh
# Re-creates the bundled detection models (models/yolo26n.onnx, models/yolo26s.onnx).
# Needs: pip install ultralytics onnx onnxslim
set -e
cd "$(dirname "$0")/../models"
for m in yolo26n yolo26s; do
  yolo export model=$m.pt format=onnx dynamic=True simplify=True imgsz=640
  rm -f "$m.pt"
done
ls -la ./*.onnx
