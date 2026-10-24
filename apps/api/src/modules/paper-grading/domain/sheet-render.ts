/**
 * Dựng ảnh phiếu dạng raster ở không gian template (CAM-0, issue #112):
 * dùng cho BỘ ẢNH KIỂM CHỨNG MÔ PHỎNG — in "ảo" một phiếu (fiducial, QR,
 * lưới mã, bong bóng đã tô theo kịch bản), rồi mô phỏng ảnh chụp (lệch
 * phối cảnh, xoay nhẹ, nhiễu, mờ, gradient sáng) và đưa qua đúng engine
 * OMR của hệ thống để đo các tiêu chí nghiệm thu Phần 4.2. Phía PDF sản
 * xuất dùng cùng hình học template (sheet-layout) nhưng vẽ vector.
 */
import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import {
  CODE_BUBBLE_R, FIDUCIAL_CENTERS, FIDUCIAL_SIZE, QR_RECT, TEMPLATE_HEIGHT, TEMPLATE_WIDTH,
  type SheetGeometry,
} from './sheet-layout';
import { computeHomography } from './omr';

export interface RgbaImage { width: number; height: number; data: Uint8ClampedArray }

function blankImage(width: number, height: number, value = 255): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = value; data[i * 4 + 1] = value; data[i * 4 + 2] = value; data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function setPx(img: RgbaImage, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
}

function fillRect(img: RgbaImage, x: number, y: number, w: number, h: number, v: number): void {
  for (let yy = Math.round(y); yy < Math.round(y + h); yy++) {
    for (let xx = Math.round(x); xx < Math.round(x + w); xx++) setPx(img, xx, yy, v);
  }
}

function fillCircle(img: RgbaImage, cx: number, cy: number, r: number, v: number): void {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) setPx(img, x, y, v);
    }
  }
}

function ringCircle(img: RgbaImage, cx: number, cy: number, r: number, v: number, width = 2.5): void {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      if (Math.abs(d - r) <= width / 2) setPx(img, x, y, v);
    }
  }
}

function drawLine(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, v: number, width = 5): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2;
  for (let s = 0; s <= steps; s++) {
    const x = x0 + ((x1 - x0) * s) / steps;
    const y = y0 + ((y1 - y0) * s) / steps;
    fillCircle(img, x, y, width / 2, v);
  }
}

export type FillStyle = 'full' | 'light' | 'check' | 'erased';
export interface SlotFill { choice: number; style: FillStyle; secondChoice?: number }

export interface RenderSheetInput {
  geometry: SheetGeometry;
  /** Payload QR (phiếu cá nhân hoá); null = phiếu trắng (vùng QR để trống viền). */
  qrText: string | null;
  /** Mã học sinh tô sẵn ở lưới mã (phiếu trắng); null = để trống toàn bộ lưới. */
  bubbleCode: string | null;
  /** Tô theo slot (1-based): lựa chọn + kiểu tô. */
  fills: ReadonlyMap<number, SlotFill>;
}

/** Dựng một phiếu hoàn chỉnh ở không gian template (chưa biến dạng chụp). */
export function renderSheetRgba(input: RenderSheetInput): RgbaImage {
  const img = blankImage(TEMPLATE_WIDTH, TEMPLATE_HEIGHT, 252);
  const { geometry } = input;
  // Fiducial.
  for (const c of FIDUCIAL_CENTERS) {
    fillRect(img, c.x - FIDUCIAL_SIZE / 2, c.y - FIDUCIAL_SIZE / 2, FIDUCIAL_SIZE, FIDUCIAL_SIZE, 10);
  }
  // Đầu phiếu: các thanh xám tượng trưng dòng chữ (OMR không đọc chữ; PDF thật có chữ tiếng Việt).
  // Thanh trên bắt đầu ở x=150 để không chạm fiducial góc trái (chiếm x 48..88, y 48..88).
  fillRect(img, 150, 62, 520, 26, 90);
  fillRect(img, 150, 104, 420, 18, 120);
  fillRect(img, 64, 150, 460, 18, 120);
  fillRect(img, 64, 250, 300, 16, 140);
  // QR hoặc khung trống.
  if (input.qrText) {
    const qr = QRCode.create(input.qrText, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const cell = QR_RECT.size / (size + 4); // quiet zone 2 module mỗi phía
    fillRect(img, QR_RECT.x, QR_RECT.y, QR_RECT.size, QR_RECT.size, 255);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (qr.modules.data[r * size + c]) {
          fillRect(img, QR_RECT.x + (c + 2) * cell, QR_RECT.y + (r + 2) * cell, Math.ceil(cell), Math.ceil(cell), 0);
        }
      }
    }
  } else {
    ringCircle(img, QR_RECT.x + QR_RECT.size / 2, QR_RECT.y + QR_RECT.size / 2, 4, 160);
    // Viền đứt tượng trưng vùng QR trống.
    for (let x = QR_RECT.x; x < QR_RECT.x + QR_RECT.size; x += 12) {
      fillRect(img, x, QR_RECT.y, 6, 2, 150);
      fillRect(img, x, QR_RECT.y + QR_RECT.size - 2, 6, 2, 150);
    }
  }
  // Lưới mã học sinh: vòng tròn cho mọi ô; tô theo bubbleCode.
  for (const cell of geometry.codeCells) {
    ringCircle(img, cell.x, cell.y, CODE_BUBBLE_R, 40);
    if (input.bubbleCode && Number(input.bubbleCode[cell.digitIndex]) === cell.value) {
      fillCircle(img, cell.x, cell.y, CODE_BUBBLE_R - 2, 15);
    }
  }
  // Lưới đáp án.
  for (const row of geometry.rows) {
    fillRect(img, row.labelX, row.labelY - 6, 30, 12, 110);
    row.centers.forEach((center, k) => {
      ringCircle(img, center.x, center.y, 13, 40);
      const fill = input.fills.get(row.slot);
      if (fill && fill.choice === k) paintFill(img, center.x, center.y, fill.style);
      if (fill?.secondChoice === k) paintFill(img, center.x, center.y, 'full');
    });
  }
  return img;
}

function paintFill(img: RgbaImage, cx: number, cy: number, style: FillStyle): void {
  if (style === 'full') fillCircle(img, cx, cy, 11, 15);
  else if (style === 'light') fillCircle(img, cx, cy, 11, 175); // tô mờ bằng bút chì nhạt
  else if (style === 'erased') {
    fillCircle(img, cx, cy, 11, 20);
    fillCircle(img, cx, cy, 7, 205); // tẩy giữa, còn vành mực
  } else {
    // Dấu ✓ thay vì tô kín (thói quen phổ biến của HS Việt Nam).
    drawLine(img, cx - 8, cy, cx - 2, cy + 7, 20, 5);
    drawLine(img, cx - 2, cy + 7, cx + 9, cy - 8, 20, 5);
  }
}

export interface PhotoSimOptions {
  /** Lệch ngẫu nhiên tối đa của mỗi góc phiếu trong ảnh chụp (px). */
  jitter?: number;
  /** Độ lệch sáng trái→phải tối đa (trừ vào giá trị điểm ảnh). */
  gradient?: number;
  /** Sigma nhiễu Gauss cộng thêm. */
  noise?: number;
  /** Số lượt làm mờ hộp 3×3 (0 = sắc nét). */
  blurPasses?: number;
  seed?: number;
}

/** Bộ sinh số giả ngẫu nhiên có hạt giống (đo nghiệm thu phải lặp lại được). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Mô phỏng một ảnh chụp điện thoại: phiếu đặt trên nền bàn tối, 4 góc bị
 * lệch phối cảnh ngẫu nhiên, cộng gradient sáng + nhiễu + tuỳ chọn mờ.
 * Trả về PNG bytes để đưa thẳng vào engine như ảnh thật.
 */
export function simulatePhoto(sheet: RgbaImage, opts: PhotoSimOptions = {}): Buffer {
  const rand = seededRandom(opts.seed ?? 42);
  const jitter = opts.jitter ?? 46;
  const gradient = opts.gradient ?? 26;
  const noise = opts.noise ?? 5;
  const W = 1860, H = 2631;
  const inset = 130;
  const corners = [
    { x: inset + (rand() * 2 - 1) * jitter, y: inset + (rand() * 2 - 1) * jitter },
    { x: W - inset + (rand() * 2 - 1) * jitter, y: inset + (rand() * 2 - 1) * jitter },
    { x: inset + (rand() * 2 - 1) * jitter, y: H - inset + (rand() * 2 - 1) * jitter },
    { x: W - inset + (rand() * 2 - 1) * jitter, y: H - inset + (rand() * 2 - 1) * jitter },
  ];
  const templateCorners = [
    { x: 0, y: 0 }, { x: TEMPLATE_WIDTH, y: 0 }, { x: 0, y: TEMPLATE_HEIGHT }, { x: TEMPLATE_WIDTH, y: TEMPLATE_HEIGHT },
  ];
  const fwd = computeHomography(templateCorners, corners);
  // Đảo để ánh xạ điểm ảnh chụp → template.
  const [a, b, c, d, e, f, g, h, i] = fwd as [number, number, number, number, number, number, number, number, number];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const inv = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
  const out = blankImage(W, H, 96); // nền bàn xám tối
  let spare: number | null = null;
  const gauss = () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0;
    while (u === 0) u = rand();
    v = rand();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const w = inv[6]! * x + inv[7]! * y + inv[8]!;
      const sx = (inv[0]! * x + inv[1]! * y + inv[2]!) / w;
      const sy = (inv[3]! * x + inv[4]! * y + inv[5]!) / w;
      let value: number;
      if (sx < 0 || sy < 0 || sx >= TEMPLATE_WIDTH - 1 || sy >= TEMPLATE_HEIGHT - 1) {
        value = 96 + gauss() * 3;
      } else {
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const fx = sx - x0, fy = sy - y0;
        const idx = (yy: number, xx: number) => sheet.data[(yy * TEMPLATE_WIDTH + xx) * 4]!;
        value = (idx(y0, x0) * (1 - fx) + idx(y0, x0 + 1) * fx) * (1 - fy)
          + (idx(y0 + 1, x0) * (1 - fx) + idx(y0 + 1, x0 + 1) * fx) * fy;
        value -= (x / W) * gradient;
        value += gauss() * noise;
      }
      const o = (y * W + x) * 4;
      const v = Math.max(0, Math.min(255, value));
      out.data[o] = v; out.data[o + 1] = v; out.data[o + 2] = v; out.data[o + 3] = 255;
    }
  }
  const passes = opts.blurPasses ?? 0;
  for (let p = 0; p < passes; p++) boxBlur(out);
  const png = new PNG({ width: W, height: H });
  png.data.set(out.data);
  return PNG.sync.write(png);
}

function boxBlur(img: RgbaImage): void {
  const src = new Uint8ClampedArray(img.data);
  const { width: W, height: H } = img;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) sum += src[((y + dy) * W + (x + dx)) * 4]!;
      }
      const v = sum / 9;
      const o = (y * W + x) * 4;
      img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v;
    }
  }
}
