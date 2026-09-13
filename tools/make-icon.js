'use strict';

/**
 * 应用图标生成器（纯 Node，无第三方依赖）。
 *
 * 为什么自己画而不是放一张图片进仓库：
 *  - 图标要跟界面主题色一致，主题改了图标就得跟着改；把「颜色」写成变量，
 *    改一处即可重跑，而不是让某个人重新导出一遍图。
 *  - 构建链里不该出现「只有设计师手上有源文件」的资产。
 *
 * 图形语义：左下节点分叉到右上与右下 —— 会话分叉（fork）是这套工作台
 * 最有辨识度的能力，比抽象字母更能说明这是什么软件。
 *
 * 抗锯齿用 2 倍超采样后降采样，比在最终分辨率上算覆盖率简单且稳定。
 *
 * 用法：node tools/make-icon.js [输出路径]
 */

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const OUT = process.argv[2] || path.join(__dirname, '..', 'apps', 'desktop', 'build', 'icon.png');

const SIZE = 1024;
const SS = 2; // 超采样倍数
const W = SIZE * SS;

// ── 主题色（与 apps/desktop/src/styles.css 的 CSS 变量保持一致）────────────
const BG_TOP = [0x1c, 0x20, 0x28]; // --bg-3
const BG_BOTTOM = [0x11, 0x13, 0x18]; // --bg
const EDGE = [0x35, 0x3d, 0x4d]; // 圆角描边
const LINE = [0x44, 0x4d, 0x5e]; // 分叉连线
const NODE_ROOT = [0xe6, 0xe9, 0xef]; // --text
const NODE_BLUE = [0x4f, 0x8c, 0xff]; // --accent
const NODE_PURPLE = [0xa3, 0x71, 0xf7]; // --purple

// ── 有符号距离场 ───────────────────────────────────────────────────────────

/** 圆角矩形：中心 (cx,cy)、半宽高 (hw,hh)、圆角半径 r */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

/** 线段（胶囊体）：端点 a、b，半宽 r */
function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const denom = bax * bax + bay * bay;
  const h = denom === 0 ? 0 : Math.min(1, Math.max(0, (pax * bax + pay * bay) / denom));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

/** 圆 */
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function mix(base, layer, alpha) {
  return [
    base[0] + (layer[0] - base[0]) * alpha,
    base[1] + (layer[1] - base[1]) * alpha,
    base[2] + (layer[2] - base[2]) * alpha,
  ];
}

// ── 绘制 ───────────────────────────────────────────────────────────────────

// 以 1024 为基准的归一化坐标，渲染时乘 W
const U = W / 1024;

function render() {
  const buffer = Buffer.alloc(W * W * 4);

  // 几何布局
  const plate = {
    cx: 512 * U,
    cy: 512 * U,
    hw: 448 * U,
    hh: 448 * U,
    r: 200 * U,
  };
  const strokeW = 5 * U;

  // 分叉：根节点在左下，两条边分别到右上与右下
  const root = { x: 336 * U, y: 560 * U, r: 62 * U };
  const top = { x: 690 * U, y: 330 * U, r: 52 * U };
  const bottom = { x: 690 * U, y: 730 * U, r: 52 * U };
  const edgeW = 30 * U;

  for (let y = 0; y < W; y += 1) {
    for (let x = 0; x < W; x += 1) {
      // 采样点取像素中心
      const px = x + 0.5;
      const py = y + 0.5;

      // 1) 底板：垂直渐变 + 圆角
      const dPlate = sdRoundRect(px, py, plate.cx, plate.cy, plate.hw, plate.hh, plate.r);
      if (dPlate > 0) continue; // 圆角外完全透明

      const t = Math.min(1, Math.max(0, py / W));
      let color = mix(BG_TOP, BG_BOTTOM, t);

      // 2) 内描边，让图标在深色任务栏上仍有边界
      const dEdge = Math.abs(dPlate + strokeW) - strokeW * 0.5;
      if (dEdge < 0) color = mix(color, EDGE, 1);

      // 3) 两条分叉连线
      const dLineTop = sdCapsule(px, py, root.x, root.y, top.x, top.y, edgeW * 0.5);
      const dLineBottom = sdCapsule(px, py, root.x, root.y, bottom.x, bottom.y, edgeW * 0.5);
      if (dLineTop < 0 || dLineBottom < 0) color = mix(color, LINE, 1);

      // 4) 三个节点圆（后画的盖住先画的，顺序即层次）
      if (sdCircle(px, py, top.x, top.y, top.r) < 0) color = mix(color, NODE_BLUE, 1);
      if (sdCircle(px, py, bottom.x, bottom.y, bottom.r) < 0) color = mix(color, NODE_PURPLE, 1);
      if (sdCircle(px, py, root.x, root.y, root.r) < 0) color = mix(color, NODE_ROOT, 1);

      const offset = (y * W + x) * 4;
      buffer[offset] = Math.round(color[0]);
      buffer[offset + 1] = Math.round(color[1]);
      buffer[offset + 2] = Math.round(color[2]);
      buffer[offset + 3] = 255;
    }
  }

  return buffer;
}

/** 2x2 块平均降采样，得到抗锯齿边缘 */
function downsample(src) {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < SS; dy += 1) {
        for (let dx = 0; dx < SS; dx += 1) {
          const offset = ((y * SS + dy) * W + (x * SS + dx)) * 4;
          // 按 alpha 加权，避免透明区域把边缘拉暗
          const av = src[offset + 3] / 255;
          r += src[offset] * av;
          g += src[offset + 1] * av;
          b += src[offset + 2] * av;
          a += av;
        }
      }
      const offset = (y * SIZE + x) * 4;
      if (a === 0) {
        out[offset] = 0;
        out[offset + 1] = 0;
        out[offset + 2] = 0;
        out[offset + 3] = 0;
      } else {
        out[offset] = Math.round(r / a);
        out[offset + 1] = Math.round(g / a);
        out[offset + 2] = Math.round(b / a);
        out[offset + 3] = Math.round((a / (SS * SS)) * 255);
      }
    }
  }
  return out;
}

// ── PNG 编码 ───────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型：RGBA
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 过滤方法
  ihdr[12] = 0; // 隔行扫描

  // 每行前置一个 filter 字节（0 = None）
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y += 1) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 执行 ───────────────────────────────────────────────────────────────────

const started = Date.now();
const pixels = downsample(render());
const png = encodePng(pixels);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);

console.log(`已生成 ${OUT}`);
console.log(`  ${SIZE}×${SIZE} RGBA · ${(png.length / 1024).toFixed(1)} KB · 耗时 ${Date.now() - started} ms`);
