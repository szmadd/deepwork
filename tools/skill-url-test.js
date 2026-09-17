'use strict';

/**
 * 技能 URL 安装源（M2-C 遗留）测试 —— 来源判定、zip 安全约束、拉取落成、真实 HTTP 往返。
 *
 *   npm run test:skillurl
 *
 * ── 这一层为什么必须有 ─────────────────────────────────────────────
 * URL 安装是本产品唯一一条「把外部内容拿到本地并让它进入模型上下文」的路径。
 * 它的失败形态不是「报错」，而是**安静地做错事**：
 *  - 一个名字带 `..` 的 zip 条目，解包时会写到目标目录之外（路径穿越）；
 *  - 一个声明为软链的条目，让后续条目借道写到任意位置；
 *  - 一个几十 KB 却能解出几十 GB 的包（zip bomb），把内存/磁盘吃光；
 *  - 按 URL 后缀猜形态，把一份 zip 的二进制当成 SKILL.md 去解析，报错指向
 *    「清单不合法」，而真正的问题是「形态判断错了」。
 * 所以断言分两层：**恶意构造的包必须被拒绝且给出具体原因**，
 * 以及**正常包必须真的走完「下载 → 剥壳 → 审计 → 装进技能目录」整条路**。
 *
 * ── 真实 HTTP 而不是桩 ─────────────────────────────────────────────
 * 拉取这一段用 Node 内置 http 起一个只监听 127.0.0.1 的小服务，
 * 让 installFromUrl 走**真实**的 fetch（含真实响应头解析）—— 用桩替换 fetch
 * 会把「响应头怎么读」这类问题一并替换掉，而那正是超限判断的依据。
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepwork-skillurl-'));
process.env.DEEPWORK_HOME = path.join(root, '.deepwork');

const {
  classifySkillSource,
  validateSkillSource,
  describeSkillSource,
} = require('../packages/protocol/dist/skills');
const { extractZip, ZIP_LIMITS } = require('../packages/core-host/dist/skills/zip');
const { materializeSkillSource } = require('../packages/core-host/dist/skills/fetch');
const { SkillStore } = require('../packages/core-host/dist/skills/store');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  [${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}
function throwsWith(fn, keyword) {
  try {
    const value = fn();
    if (value && typeof value.then === 'function') throw new Error('（异步断言请用 rejectsWith）');
  } catch (error) {
    return String(error instanceof Error ? error.message : error).includes(keyword);
  }
  return false;
}
async function rejectsWith(fn, keyword) {
  try {
    await fn();
    return false;
  } catch (error) {
    return String(error instanceof Error ? error.message : error).includes(keyword);
  }
}

// ── 极简 zip 构造器（store 方式；解包器不校验 CRC，所以 CRC 写 0）──
function buildZip(entries) {
  const chunks = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 0;
    const declared = entry.declaredSize ?? data.length;
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    chunks.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(entry.externalAttrs ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

const SKILL_MD = '---\nname: demo-skill\ndescription: 演示技能\nversion: 1.0.0\n---\n\n正文。\n';
const unpack = () => fs.mkdtempSync(path.join(root, 'unpack-'));

// ══════════════════════════════════════════════════════════
// 1. 契约层：来源判定与校验
// ══════════════════════════════════════════════════════════
console.log('\n── 来源判定 ──');

check('http/https → url；本地路径 → local-dir', classifySkillSource('https://x/y.zip') === 'url' && classifySkillSource('/tmp/a') === 'local-dir');
check(
  'Windows 盘符不被当成协议（C:\\ / D:/ 都是本地路径）',
  classifySkillSource('C:\\Users\\a\\skill') === 'local-dir' && classifySkillSource('D:/x/skill') === 'local-dir',
);
check('空来源给出可行动的错误', validateSkillSource('  ') === '技能来源不能为空');
check(
  'file:// 被明确拒绝并提示直接填路径（不落到误导性的「目录不存在」）',
  String(validateSkillSource('file:///tmp/a')).includes('不支持的协议 file:'),
  validateSkillSource('file:///tmp/a'),
);
check(
  'ftp:// 被明确拒绝（没有能力安全拉取，就别让它走到下载器里失败）',
  String(validateSkillSource('ftp://x/y')).includes('不支持的协议 ftp:'),
  validateSkillSource('ftp://x/y'),
);
check('data: 也被识别为协议而不是本地路径', classifySkillSource('data:text/plain,x') === 'url');
check('地址解析不了时如实报出（不是「清单不合法」）', String(validateSkillSource('http://')).includes('不是一个合法地址'));
check('合法 https 地址通过', validateSkillSource('https://github.com/a/b/archive/main.zip') === null);

check(
  '描述文案说清「整包 / 单文件 / 剥了壳」三件事',
  describeSkillSource({ kind: 'url', source: 'https://x/a.zip', shape: 'zip', bytes: 1234, strippedRoot: 'a-main' }).includes('zip 归档') &&
    describeSkillSource({ kind: 'url', source: 'https://x/a.zip', shape: 'zip', bytes: 1234, strippedRoot: 'a-main' }).includes('已剥掉顶层目录 a-main') &&
    describeSkillSource({ kind: 'url', source: 'https://x/SKILL.md', shape: 'skill-md', bytes: 99 }).includes('单个 SKILL.md'),
);

// ══════════════════════════════════════════════════════════
// 2. zip 安全约束（恶意构造的包必须被拒绝）
// ══════════════════════════════════════════════════════════
console.log('\n── zip 安全约束 ──');

check('随便一段字节 → 明确说「不是有效 zip」', throwsWith(() => extractZip(Buffer.from('not a zip at all'), unpack()), '不是有效的 zip'));
{
  const zip64 = Buffer.alloc(22);
  zip64.writeUInt32LE(0x06054b50, 0);
  zip64.writeUInt16LE(0xffff, 8);
  zip64.writeUInt16LE(0xffff, 10);
  check('zip64 被明确拒绝（不拿 32 位逻辑去读它）', throwsWith(() => extractZip(zip64, unpack()), 'zip64'));
}
check(
  '路径穿越条目（../）被拒绝',
  throwsWith(() => extractZip(buildZip([{ name: '../escape.txt', data: Buffer.from('x') }]), unpack()), '向上越界'),
);
check(
  '绝对路径条目被拒绝',
  throwsWith(() => extractZip(buildZip([{ name: '/etc/passwd', data: Buffer.from('x') }]), unpack()), '绝对路径'),
);
check(
  '带盘符的条目被拒绝（Windows 下的另一种绝对路径）',
  throwsWith(() => extractZip(buildZip([{ name: 'C:/x.txt', data: Buffer.from('x') }]), unpack()), '带盘符'),
);
check(
  '符号链接条目被拒绝（不然后续条目可以借道写到任意位置）',
  // unix 文件类型在高 16 位：0xA000 = 软链
  throwsWith(() => extractZip(buildZip([{ name: 'link', data: Buffer.from(''), externalAttrs: 0xa1ff0000 }]), unpack()), '符号链接'),
);
check(
  '不支持的压缩方式被拒绝',
  throwsWith(() => extractZip(buildZip([{ name: 'a.txt', data: Buffer.from('x'), method: 12 }]), unpack()), '不支持的压缩方式'),
);
check(
  '声明解压大小超上限被拒绝（先看声明再解，不看声明就等于没有上限）',
  throwsWith(
    () => extractZip(buildZip([{ name: 'big.txt', data: Buffer.from('x'), declaredSize: ZIP_LIMITS.maxEntryBytes + 1 }]), unpack()),
    '超过单文件上限',
  ),
);
check(
  '条目数超上限被拒绝',
  throwsWith(
    () => extractZip(buildZip(Array.from({ length: 3 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('x') }))), unpack(), { maxEntries: 2, maxEntryBytes: 1e6, maxTotalBytes: 1e6 }),
    '超过上限',
  ),
);

{
  const dir = unpack();
  const result = extractZip(buildZip([{ name: 'repo-main/SKILL.md', data: Buffer.from(SKILL_MD) }, { name: 'repo-main/sub/a.txt', data: Buffer.from('hi') }]), dir);
  check('正常包解出正确的文件数与字节数', result.files === 2 && result.bytes === Buffer.byteLength(SKILL_MD) + 2, `${result.files} 文件 / ${result.bytes} 字节`);
  check('子目录条目落到正确位置', fs.readFileSync(path.join(dir, 'repo-main', 'sub', 'a.txt'), 'utf8') === 'hi');
}

// ══════════════════════════════════════════════════════════
// 3. 拉取落成（形态判断 + 剥壳）
// ══════════════════════════════════════════════════════════
async function fetchSection() {
  console.log('\n── 拉取落成 ──');
  const workDir = path.join(root, 'work');
  const respond = (body, init = {}) =>
    new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });

  {
    const zip = buildZip([{ name: 'demo-1.0/SKILL.md', data: Buffer.from(SKILL_MD) }, { name: 'demo-1.0/ref.md', data: Buffer.from('附') }]);
    const made = await materializeSkillSource({ source: 'https://x/demo.zip', workDir, fetchImpl: async () => respond(zip) });
    check('zip 整包：形态判定为 zip', made.digest.shape === 'zip');
    check('zip 整包：剥掉顶层壳（否则会以「根下没有 SKILL.md」失败）', made.digest.strippedRoot === 'demo-1.0' && fs.existsSync(path.join(made.dir, 'SKILL.md')));
    check('zip 整包：记录下载字节数', made.digest.bytes === zip.length);
    made.cleanup();
    check('cleanup 清掉临时目录（未经审计的外部内容不留）', !fs.existsSync(made.dir));
  }

  {
    const made = await materializeSkillSource({ source: 'https://x/SKILL.md', workDir, fetchImpl: async () => respond(SKILL_MD) });
    check('裸 SKILL.md：形态判定为 skill-md（按内容而不是后缀）', made.digest.shape === 'skill-md' && fs.existsSync(path.join(made.dir, 'SKILL.md')));
    made.cleanup();
  }

  {
    const made = await materializeSkillSource({ source: 'https://x/download?token=abc', workDir, fetchImpl: async () => respond(buildZip([{ name: 'SKILL.md', data: Buffer.from(SKILL_MD) }])) });
    check('带查询串的下载地址也认得（没有后缀，只能按内容判）', made.digest.shape === 'zip');
    made.cleanup();
  }

  check(
    'HTTP 404 的措辞带上排查方向',
    await rejectsWith(
      () => materializeSkillSource({ source: 'https://x/a.zip', workDir, fetchImpl: async () => respond('', { status: 404 }) }),
      'HTTP 404（地址不存在',
    ),
  );
  check(
    '声明长度超上限时在读之前就拒绝',
    await rejectsWith(
      () =>
        materializeSkillSource({
          source: 'https://x/a.zip',
          workDir,
          maxBytes: 10,
          // 鸭子类型的响应：只为压「先看声明再读」这一支（真 Response 不允许
          // content-length 与实体不一致）
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: { get: (key) => (key.toLowerCase() === 'content-length' ? '9999' : null) },
            arrayBuffer: async () => new ArrayBuffer(4),
          }),
        }),
      '超过上限',
    ),
  );
  check(
    '实际长度超上限也被拒绝（响应没有 content-length 时的兜底）',
    await rejectsWith(
      () =>
        materializeSkillSource({
          source: 'https://x/a.zip',
          workDir,
          maxBytes: 10,
          fetchImpl: async () => respond(buildZip([{ name: 'a', data: Buffer.from('x') }])),
        }),
      '超过上限',
    ),
  );
  check(
    '既不是 zip 也不像 SKILL.md → 说清「形态判断」这件事，而不是「清单不合法」',
    await rejectsWith(
      () => materializeSkillSource({ source: 'https://x/a', workDir, fetchImpl: async () => respond('hello world') }),
      '既不是 zip',
    ),
  );
  check(
    '空响应被拒绝',
    await rejectsWith(() => materializeSkillSource({ source: 'https://x/a', workDir, fetchImpl: async () => respond('') }), '内容为空'),
  );
  check(
    '网络异常转成中文可读原因',
    await rejectsWith(
      () => materializeSkillSource({ source: 'https://x/a', workDir, fetchImpl: async () => { throw new Error('ENOTFOUND'); } }),
      '下载失败',
    ),
  );
  check('本地目录来源：不需要网络，cleanup 是空操作', await (async () => {
    const localDir = path.join(root, 'local-skill');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'SKILL.md'), SKILL_MD, 'utf8');
    const made = await materializeSkillSource({ source: localDir, workDir });
    const ok = made.digest.kind === 'local-dir' && made.dir === path.resolve(localDir);
    made.cleanup();
    return ok && fs.existsSync(path.join(localDir, 'SKILL.md'));
  })());
}

// ══════════════════════════════════════════════════════════
// 4. 端到端：真实 HTTP + 真装进技能目录
// ══════════════════════════════════════════════════════════
async function endToEndSection() {
  console.log('\n── 端到端（真实 HTTP 往返）──');
  const zip = buildZip([{ name: 'demo-main/SKILL.md', data: Buffer.from(SKILL_MD) }]);
  const server = http.createServer((req, res) => {
    if (req.url === '/ok.zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zip.length) });
      res.end(zip);
    } else if (req.url === '/plain.md') {
      res.writeHead(200, { 'content-type': 'text/markdown' });
      res.end(SKILL_MD);
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const store = new SkillStore();
  try {
    const installed = await store.installFromUrl(`${base}/ok.zip`, { workDir: path.join(root, 'tmp') });
    check('URL 安装成功', installed.ok === true, installed.reason);
    check('清单里写下的是原始 URL（用户能再次访问），不是临时目录', installed.ok && store.list()[0].source === `${base}/ok.zip`, store.list()[0]?.source);
    check('技能目录里真的有 SKILL.md', fs.existsSync(path.join(store.skillsDir(), 'demo-skill', 'SKILL.md')));
    check('来源摘要跟着结果回去（下载/剥壳两个中间步骤可追溯）', installed.source?.shape === 'zip' && installed.source?.strippedRoot === 'demo-main', JSON.stringify(installed.source));

    const plain = await store.installFromUrl(`${base}/plain.md`, { workDir: path.join(root, 'tmp') });
    check('裸 SKILL.md 也装得进来（同名 = 升级，仍成功）', plain.ok === true, plain.reason);

    const missing = await store.installFromUrl(`${base}/missing.zip`, { workDir: path.join(root, 'tmp') });
    check('404 失败返回结果对象而不是抛错（用户要看到原因）', missing.ok === false && missing.reason.includes('HTTP 404'), missing.reason);
    check(
      '失败后临时目录被清掉（不留未经审计的外部内容）',
      !fs.existsSync(path.join(root, 'tmp')) || fs.readdirSync(path.join(root, 'tmp')).length === 0,
      fs.existsSync(path.join(root, 'tmp')) ? fs.readdirSync(path.join(root, 'tmp')).join(',') : '（目录未创建）',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ══════════════════════════════════════════════════════════
// 5. 界面与 RPC 接线
// ══════════════════════════════════════════════════════════
function wiringSection() {
  console.log('\n── 接线 ──');
  const repo = path.resolve(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');

  const handlers = require('../packages/core-host/dist/rpc/stdio-server').buildHandlers({});
  check('RPC：skills.install 已注册（URL 与本地目录共用同一个入口，由来源判定分流）', typeof handlers['skills.install'] === 'function');

  const panel = read('apps/desktop/src/components/SkillsPanel.tsx');
  check('技能面板有 URL 安装入口，并走同一个 onInstall（不另开一条安装路径）', panel.includes('installFromUrl') && panel.includes('await onInstall(source)'));
  check('安装结果展示来源摘要', panel.includes('describeSkillSource'));
  check(
    '界面说清「URL 安装的审计发生在下载之后」（与本地安装不同的那一点）',
    panel.includes('审计'),
  );

  const agent = read('apps/desktop/src/useAgent.ts');
  check('渲染层经 skills.install 走 URL 安装', agent.includes("invoke('skills.install'"));
  check(
    '来源判定只在宿主做（渲染层不自己分流 URL / 本地目录）',
    !agent.includes('classifySkillSource') && !read('apps/desktop/src/components/SkillsPanel.tsx').includes('classifySkillSource'),
  );
  check(
    '宿主按来源分流（url → installFromUrl，否则走本地目录）',
    read('packages/core-host/src/host.ts').includes('classifySkillSource(source) === ') &&
      read('packages/core-host/src/host.ts').includes('skills.installFromUrl(source)'),
  );
}

async function main() {
  await fetchSection();
  await endToEndSection();
  wiringSection();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n技能 URL 安装源测试：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error('测试执行异常：', error);
  process.exit(1);
});
