// Minimal protobuf reader for ONNX ModelProto: reads metadata_props (class names, imgsz)
// and the first graph input's shape, without loading any ONNX library.

export function readOnnxInfo(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const meta = {};
  let inputShape = null;
  let inputName = null;

  forEachField(bytes, 0, bytes.length, (field, wt, start, end) => {
    if (wt !== 2) return;
    if (field === 14) {
      // StringStringEntryProto { key = 1; value = 2 }
      let key = '';
      let value = '';
      forEachField(bytes, start, end, (f, w, s, e) => {
        if (w !== 2) return;
        if (f === 1) key = utf8(bytes, s, e);
        else if (f === 2) value = utf8(bytes, s, e);
      });
      if (key) meta[key] = value;
    } else if (field === 7 && !inputShape) {
      // GraphProto: input = 11 (ValueInfoProto); initializers are also listed as inputs in
      // old exports, so take the first input that has a 4-d tensor shape.
      forEachField(bytes, start, end, (f, w, s, e) => {
        if (inputShape || w !== 2 || f !== 11) return;
        const vi = parseValueInfo(bytes, s, e);
        if (vi.shape && vi.shape.length === 4) {
          inputShape = vi.shape;
          inputName = vi.name;
        }
      });
    }
  });

  return {
    meta,
    inputName,
    inputShape, // e.g. [1, 3, 'height', 'width'] or [1, 3, 640, 640]
    names: parseNames(meta.names),
    imgsz: parseImgsz(meta.imgsz),
  };
}

function parseValueInfo(b, start, end) {
  let name = '';
  let shape = null;
  forEachField(b, start, end, (f, w, s, e) => {
    if (w !== 2) return;
    if (f === 1) name = utf8(b, s, e);
    else if (f === 2) {
      // TypeProto { tensor_type = 1 }
      forEachField(b, s, e, (f2, w2, s2, e2) => {
        if (f2 !== 1 || w2 !== 2) return;
        // Tensor { elem_type = 1; shape = 2 }
        forEachField(b, s2, e2, (f3, w3, s3, e3) => {
          if (f3 !== 2 || w3 !== 2) return;
          shape = [];
          // TensorShapeProto { dim = 1 } ; Dimension { dim_value = 1; dim_param = 2 }
          forEachField(b, s3, e3, (f4, w4, s4, e4) => {
            if (f4 !== 1 || w4 !== 2) return;
            let dim = null;
            forEachField(b, s4, e4, (f5, w5, s5, e5, val) => {
              if (f5 === 1 && w5 === 0) dim = val;
              else if (f5 === 2 && w5 === 2) dim = utf8(b, s5, e5);
            });
            shape.push(dim);
          });
        });
      });
    }
  });
  return { name, shape };
}

// Calls cb(field, wireType, start, end, varintValue) for each field in [pos, end).
function forEachField(b, pos, end, cb) {
  while (pos < end) {
    const [tag, p1] = readVarint(b, pos);
    pos = p1;
    const field = Math.floor(tag / 8);
    const wt = tag % 8;
    if (wt === 0) {
      const [v, p2] = readVarint(b, pos);
      cb(field, wt, pos, p2, v);
      pos = p2;
    } else if (wt === 1) {
      pos += 8;
    } else if (wt === 2) {
      const [len, p2] = readVarint(b, pos);
      const s = p2;
      const e = s + len;
      if (e > end) return;
      cb(field, wt, s, e);
      pos = e;
    } else if (wt === 5) {
      pos += 4;
    } else {
      return; // groups/unknown: stop safely
    }
  }
}

function readVarint(b, pos) {
  let result = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    const byte = b[pos++];
    result += (byte & 0x7f) * mul;
    if (byte < 0x80) break;
    mul *= 128;
  }
  return [result, pos];
}

function utf8(b, s, e) {
  return new TextDecoder().decode(b.subarray(s, e));
}

/** Ultralytics stores names as a Python dict literal: "{0: 'person', 1: 'bicycle'}". */
export function parseNames(str) {
  if (!str) return null;
  const out = [];
  const re = /(\d+)\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
  let m;
  while ((m = re.exec(str))) out[Number(m[1])] = m[2] ?? m[3];
  if (!out.length) {
    try {
      const j = JSON.parse(str);
      if (Array.isArray(j)) return j.map(String);
      for (const [k, v] of Object.entries(j)) out[Number(k)] = String(v);
    } catch {
      return null;
    }
  }
  return out.length ? out : null;
}

function parseImgsz(str) {
  if (!str) return null;
  const nums = str.match(/\d+/g);
  if (!nums) return null;
  const h = Number(nums[0]);
  const w = Number(nums[1] ?? nums[0]);
  return [h, w];
}
