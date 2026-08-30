const QR_LOG_TABLE           = new Array        (256).fill(0);
const QR_EXP_TABLE           = new Array        (256).fill(0);
for (let i = 0; i < 8; i++) QR_EXP_TABLE[i] = 1 << i;
for (let i = 8; i < 256; i++) {
  QR_EXP_TABLE[i] =
    QR_EXP_TABLE[i - 4] ^ QR_EXP_TABLE[i - 5] ^ QR_EXP_TABLE[i - 6] ^ QR_EXP_TABLE[i - 8];
}
for (let i = 0; i < 255; i++) QR_LOG_TABLE[QR_EXP_TABLE[i]] = i;

function gfMul(a        , b        )         {
  if (a === 0 || b === 0) return 0;
  return QR_EXP_TABLE[(QR_LOG_TABLE[a] + QR_LOG_TABLE[b]) % 255];
}

function polyMul(p                   , q                   )           {
  const r = new Array        (p.length + q.length - 1).fill(0);
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < q.length; j++) r[i + j] ^= gfMul(p[i], q[j]);
  }
  return r;
}

function rsGenerator(n        )           {
  let p           = [1];
  for (let i = 0; i < n; i++) p = polyMul(p, [1, QR_EXP_TABLE[i]]);
  return p;
}

function rsRemainder(data                   , nEC        )           {
  const gen = rsGenerator(nEC);
  const r = data.slice();
  for (let i = 0; i < nEC; i++) r.push(0);
  for (let i = 0; i < data.length; i++) {
    const c = r[i];
    if (c !== 0) {
      for (let j = 0; j < gen.length; j++) r[i + j] ^= gfMul(gen[j], c);
    }
  }
  return r.slice(data.length);
}

const ec = (totalDataCodewords        , ...blocks               )         => ({
  totalDataCodewords,
  blocks,
});

const EC_M                             = [
  null,
   ec(16, [1, 16, 10]),
   ec(28, [1, 28, 16]),
   ec(44, [1, 44, 26]),
   ec(64, [2, 32, 18]),
   ec(86, [2, 43, 24]),
   ec(108, [4, 27, 16]),
   ec(124, [4, 31, 18]),
   ec(154, [2, 38, 22], [2, 39, 22]),
   ec(182, [3, 36, 22], [2, 37, 22]),
   ec(216, [4, 43, 26], [1, 44, 26]),
   ec(254, [1, 50, 30], [4, 51, 30]),
   ec(290, [6, 36, 22], [2, 37, 22]),
   ec(334, [8, 37, 22], [1, 38, 22]),
   ec(365, [4, 40, 24], [5, 41, 24]),
   ec(415, [5, 41, 24], [5, 42, 24]),
   ec(453, [7, 45, 28], [3, 46, 28]),
   ec(507, [10, 46, 28], [1, 47, 28]),
   ec(563, [9, 43, 26], [4, 44, 26]),
   ec(627, [3, 44, 26], [11, 45, 26]),
   ec(669, [3, 41, 24], [13, 42, 24]),
   ec(714, [17, 42, 28]),
   ec(782, [17, 46, 28]),
   ec(860, [4, 47, 28], [14, 48, 28]),
   ec(914, [6, 45, 28], [14, 46, 28]),
   ec(1000, [8, 47, 28], [13, 48, 28]),
   ec(1062, [19, 46, 28], [4, 47, 28]),
   ec(1128, [22, 45, 28], [3, 46, 28]),
   ec(1193, [3, 45, 28], [23, 46, 28]),
   ec(1267, [21, 45, 28], [7, 46, 28]),
   ec(1373, [19, 45, 28], [10, 46, 28]),
   ec(1455, [2, 45, 28], [29, 46, 28]),
   ec(1541, [10, 45, 28], [23, 46, 28]),
   ec(1631, [14, 45, 28], [21, 46, 28]),
   ec(1725, [14, 45, 28], [23, 46, 28]),
   ec(1812, [12, 45, 28], [26, 46, 28]),
   ec(1914, [6, 45, 28], [34, 46, 28]),
   ec(1992, [29, 45, 28], [14, 46, 28]),
   ec(2102, [13, 45, 28], [32, 46, 28]),
   ec(2216, [40, 45, 28], [7, 46, 28]),
   ec(2334, [18, 45, 28], [31, 46, 28]),
];

function ecSpec(version        )         {
  const spec = EC_M[version];
  if (!spec) throw new RangeError(`qrMatrix: no EC level M spec for version ${version}`);
  return spec;
}

const ALIGN_CENTERS                                 = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

const FORMAT_INFO                    = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
];

const VERSION_INFO                    = [
  0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762, 0x0d847, 0x0e60d, 0x0f928, 0x10b78,
  0x1145d, 0x12a17, 0x13532, 0x149a6, 0x15683, 0x168c9, 0x177ec, 0x18ec4, 0x191e1, 0x1afab,
  0x1b08e, 0x1cc1a, 0x1d33f, 0x1ed75, 0x1f250, 0x209d5, 0x216f0, 0x228ba, 0x2379f, 0x24b0b,
  0x2542e, 0x26a64, 0x27541, 0x28c69,
];

function utf8Bytes(text        )           {
  const bytes           = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0x7ff) {
      bytes.push((c >> 12) | 0xe0, ((c >> 6) & 0x3f) | 0x80, (c & 0x3f) | 0x80);
    } else if (c > 0x7f) {
      bytes.push((c >> 6) | 0xc0, (c & 0x3f) | 0x80);
    } else {
      bytes.push(c);
    }
  }
  return bytes;
}

function countIndicatorBits(version        )         {
  return version < 10 ? 8 : 16;
}

function encodeData(text        , version        )                  {
  const bytes = utf8Bytes(text);
  const n = bytes.length;
  const ccBits = countIndicatorBits(version);

  const totalBits = 4 + ccBits + 8 * n + 4;
  const totalDC = ecSpec(version).totalDataCodewords;
  if (totalBits > totalDC * 8) return null;

  const buf           = [];
  let byt = 0;
  let bits = 0;
  const pushBits = (value        , nb        )       => {
    for (let i = nb - 1; i >= 0; i--) {
      byt = (byt << 1) | ((value >> i) & 1);
      if (++bits === 8) {
        buf.push(byt);
        byt = 0;
        bits = 0;
      }
    }
  };

  pushBits(4, 4);
  pushBits(n, ccBits);
  for (let i = 0; i < n; i++) pushBits(bytes[i], 8);
  pushBits(0, 4);
  while (bits > 0) pushBits(0, 1);

  const padBytes = [0xec, 0x11];
  let pi = 0;
  while (buf.length < totalDC) {
    buf.push(padBytes[pi & 1]);
    pi++;
  }
  return buf;
}

function buildCodewords(dataBuf                   , version        )           {
  const spec = ecSpec(version);
  const blocks                                    = [];
  let offset = 0;
  for (const [count, dcPerBlock, ecPerBlock] of spec.blocks) {
    for (let k = 0; k < count; k++) {
      const dc = dataBuf.slice(offset, offset + dcPerBlock);
      offset += dcPerBlock;
      blocks.push({ dc, ecc: rsRemainder(dc, ecPerBlock) });
    }
  }

  const result           = [];
  const maxDC = blocks.reduce((m, b) => Math.max(m, b.dc.length), 0);
  for (let i = 0; i < maxDC; i++) {
    for (const block of blocks) if (i < block.dc.length) result.push(block.dc[i]);
  }
  const maxEC = blocks.reduce((m, b) => Math.max(m, b.ecc.length), 0);
  for (let i = 0; i < maxEC; i++) {
    for (const block of blocks) if (i < block.ecc.length) result.push(block.ecc[i]);
  }
  return result;
}

function makeMatrix(size        )             {
  const m             = [];
  for (let r = 0; r < size; r++) m.push(new Array        (size).fill(null));
  return m;
}

function qrSize(version        )         {
  return version * 4 + 17;
}

function placeFinder(m            , r        , c        )       {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= m.length || cc < 0 || cc >= m.length) continue;
      if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
        const edge = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        m[rr][cc] = edge || inner ? 1 : 0;
      } else {
        m[rr][cc] = 0;
      }
    }
  }
}

function placeAlignment(m            , row        , col        )       {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const edge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
      const center = dr === 0 && dc === 0;
      m[row + dr][col + dc] = edge || center ? 1 : 0;
    }
  }
}

function placeTiming(m            , size        )       {
  for (let i = 8; i < size - 8; i++) {
    const v         = i % 2 === 0 ? 1 : 0;
    if (m[6][i] === null) m[6][i] = v;
    if (m[i][6] === null) m[i][6] = v;
  }
}

function reserveFormatAreas(m            , size        )       {
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 0;
    if (m[i][8] === null) m[i][8] = 0;
  }
  for (let i = size - 8; i < size; i++) {
    if (m[8][i] === null) m[8][i] = 0;
    if (m[i][8] === null) m[i][8] = 0;
  }
  m[size - 8][8] = 1;
}

function reserveVersionAreas(m            , size        )       {
  for (let i = 0; i < 6; i++) {
    for (let j = size - 11; j < size - 8; j++) {
      m[i][j] = 0;
      m[j][i] = 0;
    }
  }
}

function placeData(m            , size        , codewords                   )       {
  let bitIndex = 0;
  let dir = -1;
  let row = size - 1;
  let col = size - 1;
  while (col >= 0) {
    if (col === 6) col--;
    while (row >= 0 && row < size) {
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (m[row][c] !== null) continue;
        const byteIdx = bitIndex >> 3;
        const bitPos = 7 - (bitIndex & 7);
        const bit         = byteIdx < codewords.length ? (((codewords[byteIdx] >> bitPos) & 1)          ) : 0;
        m[row][c] = bit;
        bitIndex++;
      }
      row += dir;
    }
    dir = -dir;
    row += dir;
    col -= 2;
  }
}

const MASK_FUNCTIONS                                                 = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(
  m            ,
  size        ,
  maskId        ,
  fnMask                                 ,
)       {
  const maskFn = MASK_FUNCTIONS[maskId];
  for (let r = 0; r < size; r++) {
    const row = m[r];
    const fnRow = fnMask[r];
    for (let c = 0; c < size; c++) {
      const value = row[c];
      if (fnRow[c]) continue;
      if (value !== 0 && value !== 1) continue;
      if (maskFn(r, c)) row[c] = (value ^ 1)          ;
    }
  }
}

function placeFormat(m            , size        , maskId        )       {
  const fi = FORMAT_INFO[maskId];
  const bit = (k        )         => ((fi >> k) & 1)          ;

  for (let c = 0; c <= 5; c++) m[8][c] = bit(14 - c);
  m[8][7] = bit(8);
  m[8][8] = bit(7);
  m[7][8] = bit(6);
  for (let r = 0; r <= 5; r++) m[r][8] = bit(r);

  for (let k = 0; k <= 7; k++) m[8][size - 1 - k] = bit(k);
  for (let k = 8; k <= 14; k++) m[size - 15 + k][8] = bit(k);
}

function placeVersion(m            , size        , version        )       {
  if (version < 7) return;
  const vi = VERSION_INFO[version - 7];
  for (let k = 0; k < 18; k++) {
    const value = ((vi >> k) & 1)          ;
    const row = Math.floor(k / 3);
    const col = size - 11 + (k % 3);
    m[row][col] = value;
    m[col][row] = value;
  }
}

function penalty(m            , size        )         {
  let p = 0;

  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (m[r][c] === m[r][c - 1]) {
        run++;
        if (run === 5) p += 3;
        else if (run > 5) p++;
      } else run = 1;
    }
    run = 1;
    for (let c = 1; c < size; c++) {
      if (m[c][r] === m[c - 1][r]) {
        run++;
        if (run === 5) p += 3;
        else if (run > 5) p++;
      } else run = 1;
    }
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) p += 3;
    }
  }

  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      let rowMatch1 = true;
      let rowMatch2 = true;
      let colMatch1 = true;
      let colMatch2 = true;
      for (let i = 0; i < 11; i++) {
        if (m[r][c + i] !== pat1[i]) rowMatch1 = false;
        if (m[r][c + i] !== pat2[i]) rowMatch2 = false;
        if (m[c + i][r] !== pat1[i]) colMatch1 = false;
        if (m[c + i][r] !== pat2[i]) colMatch2 = false;
      }
      if (rowMatch1) p += 40;
      if (rowMatch2) p += 40;
      if (colMatch1) p += 40;
      if (colMatch2) p += 40;
    }
  }

  let dark = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) if (m[r][c] === 1) dark++;
  }
  const pct = (dark / (size * size)) * 100;
  const prev5 = Math.floor(pct / 5) * 5;
  const next5 = prev5 + 5;
  p += (Math.min(Math.abs(prev5 - 50), Math.abs(next5 - 50)) / 5) * 10;
  return p;
}

function buildMatrix(version        , codewords                   , maskId        )             {
  const size = qrSize(version);
  const m = makeMatrix(size);

  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);

  const ac = ALIGN_CENTERS[version];
  for (const r of ac) {
    for (const c of ac) {
      if (m[r][c] !== null) continue;
      placeAlignment(m, r, c);
    }
  }

  placeTiming(m, size);

  reserveFormatAreas(m, size);
  if (version >= 7) reserveVersionAreas(m, size);

  const fnMask              = [];
  for (let r = 0; r < size; r++) {
    const row            = [];
    for (let c = 0; c < size; c++) row.push(m[r][c] !== null);
    fnMask.push(row);
  }

  placeData(m, size, codewords);
  applyMask(m, size, maskId, fnMask);

  placeFormat(m, size, maskId);
  if (version >= 7) placeVersion(m, size, version);

  return m;
}

const QR_QUIET_ZONE_MODULES = 4;

function qrMatrix(text        )              {

  let version = -1;
  const byteCount = utf8Bytes(text).length;
  for (let v = 1; v <= 40; v++) {
    const dataBits = 4 + countIndicatorBits(v) + 8 * byteCount;
    if (dataBits <= ecSpec(v).totalDataCodewords * 8) {
      version = v;
      break;
    }
  }
  if (version === -1) throw new RangeError("qrMatrix: text too long for QR version 40");

  const dataBuf = encodeData(text, version);
  if (dataBuf === null) throw new RangeError("qrMatrix: text too long for QR version 40");

  const codewords = buildCodewords(dataBuf, version);
  const size = qrSize(version);

  let bestMatrix                    = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = buildMatrix(version, codewords, mask);
    const p = penalty(candidate, size);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMatrix = candidate;
    }
  }
  if (bestMatrix === null) throw new Error("qrMatrix: no mask candidate produced");

  const q = QR_QUIET_ZONE_MODULES;
  const result              = [];
  for (let r = 0; r < size + 2 * q; r++) {
    const row            = [];
    for (let c = 0; c < size + 2 * q; c++) {
      if (r < q || r >= size + q || c < q || c >= size + q) {
        row.push(false);
      } else {
        row.push(bestMatrix[r - q][c - q] === 1);
      }
    }
    result.push(row);
  }
  return result;
}

module.exports = { QR_QUIET_ZONE_MODULES, qrMatrix };
