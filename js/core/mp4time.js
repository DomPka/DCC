// Reads the recording start time from an MP4/MOV file (moov > mvhd creation_time)
// by walking box headers with File.slice, so multi-GB drone videos are never loaded whole.
// Returns the digits exactly as stored (most drones/cameras write local time there),
// as {date: Date (UTC fields = stored digits), iso: 'YYYY-MM-DDTHH:MM:SS'} or null.

const MAC_EPOCH_OFFSET = 2082844800; // seconds between 1904-01-01 and 1970-01-01

export async function readMp4CreationTime(file) {
  try {
    const moov = await findTopLevelBox(file, 'moov');
    if (!moov) return null;
    const maxRead = Math.min(moov.size, 64 * 1024 * 1024);
    const buf = new Uint8Array(await file.slice(moov.offset, moov.offset + maxRead).arrayBuffer());
    const mvhd = findChild(buf, moov.headerSize, buf.length, 'mvhd');
    if (!mvhd) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset);
    const version = buf[mvhd.start];
    let secs;
    if (version === 1) {
      const hi = dv.getUint32(mvhd.start + 4);
      const lo = dv.getUint32(mvhd.start + 8);
      secs = hi * 4294967296 + lo;
    } else {
      secs = dv.getUint32(mvhd.start + 4);
    }
    if (!secs) return null;
    const ms = (secs - MAC_EPOCH_OFFSET) * 1000;
    const date = new Date(ms);
    const year = date.getUTCFullYear();
    if (year < 2000 || year > 2100) return null;
    return { date, iso: date.toISOString().slice(0, 19) };
  } catch {
    return null;
  }
}

async function findTopLevelBox(file, type) {
  let offset = 0;
  const size = file.size;
  for (let guard = 0; offset + 8 <= size && guard < 10000; guard++) {
    const head = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    let boxSize = head.getUint32(0);
    const boxType = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    let headerSize = 8;
    if (boxSize === 1 && head.byteLength >= 16) {
      boxSize = head.getUint32(8) * 4294967296 + head.getUint32(12);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = size - offset;
    }
    if (boxSize < headerSize) return null;
    if (boxType === type) return { offset, size: boxSize, headerSize };
    offset += boxSize;
  }
  return null;
}

function findChild(buf, start, end, type) {
  const dv = new DataView(buf.buffer, buf.byteOffset);
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const t = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    let hs = 8;
    if (size === 1) {
      size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12);
      hs = 16;
    } else if (size === 0) size = end - p;
    if (size < hs) return null;
    if (t === type) return { start: p + hs, end: Math.min(end, p + size) };
    p += size;
  }
  return null;
}
