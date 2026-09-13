'use strict';

/**
 * 差异引擎随机对拍。
 *
 *   npm run test:diff
 *
 * 为什么值得单独一个测试：diff 是审批链路的证据来源 ——
 * 用户是「看着这份差异」点允许的。如果差异算错（少显示一行删除、把两处改动合并歪了），
 * 审批就变成了一次盲签，而且错得非常安静，肉眼很难发现。
 *
 * 手写样例覆盖不到的组合，靠随机对拍来补：
 *  - 行内容取自极小的字母表（a/b/c），刻意制造大量重复行 —— 这是最容易让 diff 算错的输入；
 *  - 变异算子混合增删改与块级操作，覆盖局部编辑与整段重排；
 *  - 每轮都断言「差异应用回原文 == 新文」。
 *
 * 随机数用固定种子的 mulberry32，失败时可复现。
 */

const { buildFileDiff, applyDiff, applySelectedHunks, pickHunks, splitLines } = require('../packages/core-host/dist/diff');

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  bold: '\u001b[1m',
};

const ROUNDS = Number(process.env.DIFF_ROUNDS ?? 1000);
/** 行内容字母表：越小越容易撞行，越容易触发 diff 的边界 */
const ALPHABET = ['a', 'b', 'c', '', 'x y', '  indented', '{}', '# 注释'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260912);
const pick = (list) => list[Math.floor(rand() * list.length)];
const int = (max) => Math.floor(rand() * max);

function randomLines(count) {
  return Array.from({ length: count }, () => pick(ALPHABET));
}

/** 施加若干随机变异，返回新行数组 */
function mutate(lines) {
  const out = [...lines];
  const rounds = 1 + int(5);
  for (let i = 0; i < rounds; i += 1) {
    const op = int(6);
    const at = out.length ? int(out.length) : 0;
    if (op === 0 && out.length) out[at] = pick(ALPHABET);                          // 改行
    else if (op === 1 && out.length) out.splice(at, 1);                            // 删行
    else if (op === 2) out.splice(at, 0, pick(ALPHABET));                          // 插行
    else if (op === 3 && out.length > 1) {                                         // 交换相邻
      const j = Math.min(at, out.length - 2);
      [out[j], out[j + 1]] = [out[j + 1], out[j]];
    } else if (op === 4 && out.length) {                                           // 删块
      out.splice(at, 1 + int(Math.min(4, out.length - at)));
    } else if (out.length) {                                                       // 复制块
      const len = 1 + int(Math.min(3, out.length - at));
      out.splice(at, 0, ...out.slice(at, at + len));
    }
  }
  return out;
}

function toText(lines) {
  return lines.length ? `${lines.join('\n')}\n` : '';
}

let failures = 0;
let checked = 0;
let withChanges = 0;
let partialChecked = 0;
let partialFailures = 0;

/** 逐 hunk 应用的一组性质断言；失败时打印可复现的输入 */
function checkPartial(oldText, newText, path) {
  const diff = buildFileDiff({ path, oldText, newText });
  if (diff.hunks.length < 2) return; // 单块时「选块」与「全选」等价，没有可验证的区分度

  partialChecked += 1;

  const problems = [];
  const all = diff.hunks.map((_, index) => index);

  // 性质 1：一个都不采纳 == 原文（逐字节，行尾也不许动）
  if (applySelectedHunks(oldText, diff, []) !== oldText) {
    problems.push('空选择未还原为原文');
  }
  // 性质 2：省略选择 / 全选，都应与目标文件逐字节一致
  if (applySelectedHunks(oldText, diff, undefined) !== newText) {
    problems.push('省略选择时与目标文件不一致');
  }
  if (applySelectedHunks(oldText, diff, all) !== newText) {
    problems.push('全选与目标文件不一致');
  }
  // 性质 3：单独采纳某一块，其结果相对原文只应体现这一块的增删，
  //         且不能把别的块「顺带」带进来 —— 这是部分应用最容易出的错
  for (let i = 0; i < diff.hunks.length; i += 1) {
    const only = applySelectedHunks(oldText, diff, [i]);
    const again = buildFileDiff({ path, oldText, newText: only });
    const expectedAdded = diff.hunks[i].lines.filter((line) => line.kind === 'add').length;
    const expectedRemoved = diff.hunks[i].lines.filter((line) => line.kind === 'remove').length;
    if (again.added !== expectedAdded || again.removed !== expectedRemoved) {
      problems.push(
        `只采纳第 ${i} 块时增删为 +${again.added} −${again.removed}，应为 +${expectedAdded} −${expectedRemoved}`,
      );
      break;
    }
    if (again.hunks.length !== 1) {
      problems.push(`只采纳第 ${i} 块却产生了 ${again.hunks.length} 个 hunk`);
      break;
    }
  }

  if (problems.length) {
    partialFailures += 1;
    if (partialFailures <= 3) {
      console.log(`${C.red}✗ 部分应用失败（${path}）：${problems.join('；')}${C.reset}`);
      console.log(`${C.dim}旧：${JSON.stringify(oldText)}${C.reset}`);
      console.log(`${C.dim}新：${JSON.stringify(newText)}${C.reset}`);
    }
  }
}

for (let round = 0; round < ROUNDS; round += 1) {
  const a = randomLines(int(25));
  const b = rand() < 0.05 ? randomLines(int(25)) : mutate(a);

  const oldText = round % 11 === 0 ? null : toText(a); // 偶尔测「新建文件」
  const newText = toText(b);

  const diff = buildFileDiff({ path: 'sample.txt', oldText, newText });
  const expected = splitLines(newText).join('\n');
  const actual = applyDiff(oldText === null ? '' : oldText, diff);
  checked += 1;

  const changed = oldText === null || expected !== splitLines(oldText).join('\n');
  if (changed) withChanges += 1;

  // 新建 0 字节文件是合法边界：created=true 但没有行，增删为 0 是正确的
  const emptyCreate = oldText === null && expected === '';

  const problems = [];
  if (actual !== expected) problems.push('还原结果与新文不一致');
  if (changed && !emptyCreate && diff.added + diff.removed === 0) problems.push('内容有变化但增删计数为 0');
  if (oldText === null && !diff.created) problems.push('新建文件未标记 created');
  if (diff.truncated) problems.push('意外触发截断');

  if (problems.length) {
    failures += 1;
    if (failures <= 3) {
      console.log(`${C.red}✗ 第 ${round} 轮失败：${problems.join('；')}${C.reset}`);
      console.log(`${C.dim}旧：${JSON.stringify(oldText)}${C.reset}`);
      console.log(`${C.dim}新：${JSON.stringify(newText)}${C.reset}`);
      console.log(`${C.dim}还原：${JSON.stringify(actual)}${C.reset}`);
    }
  }

  // 部分应用的性质需在多块差异上才有区分度，用更长的输入单独造
  if (oldText !== null) checkPartial(oldText, newText, 'partial.txt');
  const longOld = toText(randomLines(30 + int(30)));
  checkPartial(longOld, toText(mutate(splitLines(longOld))), 'partial-long.txt');
}

// ── 行尾保真：部分应用不得把整份文件的 CRLF 洗成 LF ──────────────
function checkCrlf() {
  const crlfOld = 'alpha\r\nbeta\r\ngamma\r\n' + Array.from({ length: 30 }, (_, i) => `pad ${i}\r\n`).join('') ;
  const crlfNew = crlfOld.replace('beta\r\n', 'beta CHANGED\r\n').replace('pad 20\r\n', 'pad 20 CHANGED\r\n');
  const diff = buildFileDiff({ path: 'crlf.txt', oldText: crlfOld, newText: crlfNew });
  if (diff.hunks.length < 2) return { ok: false, detail: '未切出两个 hunk，样例需要调整' };

  const result = applySelectedHunks(crlfOld, diff, [0]);
  const lone = /(^|[^\r])\n/.test(result);
  const keptCrlf = result.includes('beta CHANGED\r\n') && result.includes('pad 20\r\n');
  return {
    ok: !lone && keptCrlf,
    detail: lone ? '部分应用引入了孤立 LF（行尾被改写）' : 'CRLF 与未采纳内容均保持原样',
  };
}
const crlf = checkCrlf();
if (!crlf.ok) partialFailures += 1;

// ── pickHunks 与 applySelectedHunks 必须口径一致 ────────────────
function checkPickConsistency() {
  const oldText = toText(Array.from({ length: 30 }, (_, i) => `row ${i}`));
  const newText = toText(
    Array.from({ length: 30 }, (_, i) => (i === 4 || i === 25 ? `row ${i} CHANGED` : `row ${i}`)),
  );
  const diff = buildFileDiff({ path: 'pick.txt', oldText, newText });
  if (diff.hunks.length < 2) return { ok: false, detail: '未切出两个 hunk' };
  const subset = pickHunks(diff, [1]);
  // 用「只保留第 1 块」的差异去应用，结果应与按选择应用一致
  const viaPick = applySelectedHunks(oldText, subset, undefined);
  const viaSelect = applySelectedHunks(oldText, diff, [1]);
  return { ok: viaPick === viaSelect, detail: viaPick === viaSelect ? '两种口径结果一致' : 'pickHunks 与 applySelectedHunks 结果不一致' };
}
const pickResult = checkPickConsistency();
if (!pickResult.ok) partialFailures += 1;

console.log(`${C.bold}差异引擎随机对拍${C.reset}  种子=20260912 轮次=${ROUNDS}`);
console.log(`覆盖样例        ${checked}（其中 ${withChanges} 例确有改动）`);
console.log(`部分应用性质    ${partialChecked} 例多块差异`);
console.log(`行尾保真        ${crlf.ok ? `${C.green}通过${C.reset}` : `${C.red}${crlf.detail}${C.reset}`}`);
console.log(`口径一致性      ${pickResult.ok ? `${C.green}通过${C.reset}` : `${C.red}${pickResult.detail}${C.reset}`}`);
console.log(
  `还原一致性      ${
    failures === 0 && partialFailures === 0
      ? `${C.green}全部通过${C.reset}`
      : `${C.red}整体 ${failures} 例 / 部分应用 ${partialFailures} 例失败${C.reset}`
  }`,
);

process.exit(failures === 0 && partialFailures === 0 ? 0 : 1);
