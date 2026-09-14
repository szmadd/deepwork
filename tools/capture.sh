#!/usr/bin/env bash
# 里程碑验收截图。
#
# 为什么要一个脚本而不是手敲命令：
# 截图里必须出现「真的跑过的会话」——真实的工具卡片、真实的差异、真实的退出码。
# 手工敲的时候每次环境变量都可能不太一样，出来的图就不可复现；
# 而验收截图的价值恰恰在于「照着它可以把同一幅画面再跑出来一次」。
#
# 一个容易踩的坑：Electron 是原生 Windows 程序，环境变量里的路径必须是 D:/... 形式。
# 传 /d/... 时它既不报错也不截图，只是安静地什么都不做 —— 所以这里统一做转换。
#
# 用法： bash tools/capture.sh [场景名...]    # 不带参数则跑全部

set -u

REPO_MSYS="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(printf '%s' "$REPO_MSYS" | sed -E 's|^/([a-zA-Z])/|\1:/|')"
DESKTOP="$REPO_MSYS/apps/desktop"
OUT="$REPO_MSYS/artifacts"
OUT_WIN="$REPO/artifacts"
WORKSPACE_WIN="$REPO/artifacts/demo-workspace"
HOME_WIN="$REPO/artifacts/.deepwork"
ELECTRON_MSYS="$REPO_MSYS/node_modules/electron/dist/electron.exe"
# 浏览器场景用的演示页与它的 file URL。
# 页面的路径形式不能想当然：file URL 里盘符前那一个斜杠属于 URL 语法，
# 少了它浏览器会当成主机名 D，报「找不到服务器」而不是「文件不存在」。
BROWSER_PAGE_WIN="$REPO/tools/fixtures/browser-page.html"
BROWSER_URL="file:///$BROWSER_PAGE_WIN"

export PATH="/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/bin:/c/Windows/System32:/c/Windows:/c/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3:$PATH"

# Electron 以纯 Node 模式跑的开关必须清掉，否则它不会启动 GUI
unset ELECTRON_RUN_AS_NODE

if [ ! -x "$ELECTRON_MSYS" ]; then
  echo "未找到 Electron 可执行文件：$ELECTRON_MSYS" >&2
  exit 1
fi
if [ ! -f "$OUT/demo-workspace/package.json" ]; then
  echo "缺少演示工作区：$OUT/demo-workspace" >&2
  exit 1
fi
# 截图前先重建产物。
#
# 为什么必须显式做这件事：Electron 加载的是 apps/desktop/dist 里的渲染层 bundle，
# 它**不会**跟着源码改动自动更新。此前脚本没建它，于是出现过「截图成功、画面却是上一版 UI」——
# 日志全绿、文件也写出来了，只有图是旧的。这是「看起来成功了」的最坏形态：
# 验收截图一旦不可信，DEVLOG 里引用它的那句话就没有依据。
if [ "${DEEPWORK_SKIP_BUILD:-0}" != "1" ]; then
  echo "── 重建产物（protocol / core-host / 渲染层）"
  ( cd "$REPO_MSYS" && npm run build >/dev/null 2>&1 && npm run build:renderer -w @deepwork/desktop >/dev/null 2>&1 ) || {
    echo "构建失败，已中止：一张旧 UI 的截图比没有截图更糟" >&2
    exit 1
  }
fi

# 浏览器场景需要系统里真的有 Edge 或 Chrome（且选浏览器的逻辑要能跑）。
# 没有就跳过那一场并明确出声：产出一张「未启动」的空面板截图，
# 等于用一张看起来正常的图把一个能力缺失藏起来。
BROWSER_OK=1
# 路径必须用原生 D:/ 形式：node 是原生 Windows 程序，不认 msys 的 /d/ 前缀。
# 用错形式的症状是 require 失败 → 判定「没有浏览器」→ 场景被安静跳过，
# 而机器上明明装着 Edge。
if ! node -e "const {findBrowserExecutable}=require('$REPO/packages/core-host/dist/browser/cdp');process.exit(findBrowserExecutable()?0:1)" >/dev/null 2>&1; then
  BROWSER_OK=0
  echo "提示：未找到 Edge/Chrome，将跳过 browser 场景" >&2
fi

# Office 场景需要系统里真的装了 WPS/Office：判据是「能被真实办公软件打开」，
# 没有办公软件时那一条就是验不了的。跳过并出声，不产出一张假的空图。
# 探测用 msys 路径（这是给 shell 看的），传给 node/electron 时仍用 $REPO 的原生形式。
OFFICE_EXE="$(ls -d /c/Users/*/AppData/Local/Kingsoft/WPS\ Office/*/office6/wps.exe \
  "/c/Program Files/WPS Office"/*/office6/wps.exe \
  "/c/Program Files (x86)/Microsoft Office"/root/Office1*/WINWORD.EXE 2>/dev/null | head -1)"
if [ -z "$OFFICE_EXE" ]; then
  echo "提示：未找到 WPS/Office，将跳过 office 场景" >&2
fi

PROMPT="${DEEPWORK_PROMPT:-梳理一下这个工程：先看目录结构，读一个配置文件，确认运行时版本，然后写一份运行笔记并根据复核结果修订它。}"
LOG="$OUT/.capture.log"

# 每场截图前把「上一次跑出来的痕迹」清掉。
#
# 演示脚本是「新建 → 精确替换 → 补全」三步，第二步要求文件里还存在 `- 复核结论：待复核` 那一行；
# 上一场跑完后它已经被改成 `已复核`，不重置的话第二场的第二步必然失败，
# 画面就和第一场不一样了 —— 而验收截图的全部价值就在于「照着它能把同一幅画面再跑出来一次」。
#
# 会话数据（$OUT/.deepwork）同样要清：不清的话画面里会叠着上一次的运行记录，
# 看到的到底是这次代码跑出来的、还是上次留下的，从图上分不出来。
reset_fixture() {
  # 为什么用 node 而不是 rm -rf：
  # 本机 shell 层包了一道删除保护（SAFE_DELETE_BULK_CONFIRM_REQUIRED），按「一次会话内
  # 累计删除的文件数」计数，越过阈值就拒绝执行。跑一趟 11 场必然越过，于是从第 5 场起
  # reset 静默失效：`.deepwork` 带着前面几场的会话一起进画面（用量页显示「4 会话 / 14 次调用」，
  # 而脚本预置的只有 3 个会话 / 8 次调用），`AGENT-NOTES.md` 也不再回到三步链的初始态。
  # 后果是截图不可复现 —— 而「照着它能再跑出同一幅画面」正是验收截图的全部价值。
  # node 的 fs.rmSync 不受那层 shell 包装影响；这里要删的路径写死、且都是本脚本自己的运行数据。
  # 上一次若被 Ctrl-C 之类中断，会留下一个活着的浏览器与指向它的端点文件。
  # 先按端点把整棵进程树收掉，再删运行数据 —— 否则下一次 ensure 会去「复用」
  # 一个 profile 已被删掉的浏览器，行为不可预测（画面也就不可复现）。
  node -e 'const fs=require("fs"),path=require("path"),{spawnSync}=require("child_process");try{const e=JSON.parse(fs.readFileSync(path.join(process.argv[1],"browser-endpoint.json"),"utf8"));if(e.pid)spawnSync("taskkill",["/pid",String(e.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});}catch{}' "$HOME_WIN"
  node -e 'const fs=require("fs");for(const p of process.argv.slice(1))fs.rmSync(p,{recursive:true,force:true});' \
    "$HOME_WIN" "$WORKSPACE_WIN/AGENT-NOTES.md" "$WORKSPACE_WIN/.deepwork"
}

run_scene() {
  local name="$1" focus="$2" script="$3" hold_partial="$4" post_reset="${5:-}"
  echo "── 截图场景：$name"
  reset_fixture
  # 某些场景需要在清空 fixture 之后、应用启动之前预置数据（如技能场景要真的装一个技能）
  if [ -n "$post_reset" ]; then
    eval "$post_reset" || { echo "   ! 预置数据失败：$name" >&2; return 1; }
  fi
  ( cd "$DESKTOP" && \
    DEEPWORK_CAPTURE="$OUT_WIN/$name.png" \
    DEEPWORK_CAPTURE_FOCUS="$focus" \
    DEEPWORK_CAPTURE_SCRIPT="$script" \
    DEEPWORK_CAPTURE_HOLD_PARTIAL="$hold_partial" \
    DEEPWORK_CAPTURE_APPROVE_DELAY=0 \
    DEEPWORK_CAPTURE_DELAY=4000 \
    DEEPWORK_CAPTURE_PROMPT="$PROMPT" \
    DEEPWORK_WORKSPACE="$WORKSPACE_WIN" \
    DEEPWORK_HOME="$HOME_WIN" \
    "$ELECTRON_MSYS" . > "$LOG" 2>&1 )

  grep -E '^\[capture\]' "$LOG" | sed 's/^/   /'
  grep -iE 'error|failed|异常' "$LOG" | grep -v '^\[core-host\]' | sed 's/^/   ! /' | head -5
}

# 面板默认收起，截图脚本负责把它们点开。
#
# 「切到某个视图」写成函数而不是直接拼字符串，是因为拼接会踩一个很隐蔽的坑：
# 脚本是一整段 IIFE，前一段里的 `return` 会让拼在它后面的代码变成死代码，
# 而返回值看起来还是成功的 —— 表面上什么都对，只有截图里少了本该出现的东西。
# 这个坑真出现过一次（预览弹窗怎么都不出来），所以这里宁可多写一个函数。
#
# M2-J 起功能入口从标题栏横排按钮换成了左侧活动栏（rail），因此这里按 title 找图标按钮。
# 找的是 `title` 而不是文本：rail 项只有图标，没有可读文本 —— 这一点也正是
# 「点不到就返回 no-rail」必须存在的原因。
RAIL_HELPER='const openRail=async(label)=>{const b=[...document.querySelectorAll(".rail-item")].find(x=>x.getAttribute("title")===label);if(!b)return "no-rail:"+label;b.click();await new Promise(r=>setTimeout(r,1600));return "ok";};'

SCENES="${*:-chat tree terminal preview hunk settings skills memory schedule connectors usage browser office}"

for scene in $SCENES; do
  case "$scene" in
    chat)
      # 主布局本身也要有截图：活动栏 + 会话列表 + 对话三者同框，
      # 这是「布局改了什么」最直接的证据，别的场景都聚焦在各自的页面上
      run_scene "ui-chat" ".stream" "$RAIL_HELPER return await openRail('对话');" "0"
      ;;
    tree)
      run_scene "ui-tree" ".tree-changed" "$RAIL_HELPER return await openRail('文件');" "0"
      ;;
    terminal)
      run_scene "ui-terminal" ".terminal-block" \
        "$RAIL_HELPER await openRail('终端'); const i=document.querySelector('.terminal-input'); if(!i) return 'no-input'; const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i,'node -v && echo 终端中文输出正常'); i.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,300)); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await new Promise(r=>setTimeout(r,2800)); return 'ok';" \
        "0"
      ;;
    preview)
      run_scene "ui-preview" ".preview-text" \
        "$RAIL_HELPER await openRail('文件'); const f=document.querySelector('.tree-changed'); if(!f) return 'no-changed-file'; f.click(); await new Promise(r=>setTimeout(r,2000)); return 'ok';" \
        "0"
      ;;
    hunk)
      # 勾选框只在弹窗里出现，选择器限定在 .modal-mask 内；
      # 末尾把「已选 N / M」回读出来当作脚本自己的回执 —— 点了没生效时日志里看得见，
      # 否则一张显示「2 / 2」的截图看起来就像功能坏了，其实是脚本没点中。
      run_scene "ui-hunk-approval" ".diff-selection-bar" \
        "const boxes=document.querySelectorAll('.modal-mask .diff-hunk-check input'); if(boxes.length<2) return 'boxes='+boxes.length; boxes[1].click(); await new Promise(r=>setTimeout(r,600)); const bar=document.querySelector('.diff-selection-bar'); return bar ? bar.textContent.slice(0,10) : 'no-bar';" \
        "1"
      ;;
    settings)
      run_scene "ui-settings" ".settings-tabs" \
        "$RAIL_HELPER await openRail('设置'); const t=[...document.querySelectorAll('.settings-tab')].find(x=>x.textContent.includes('模型')); if(t){ t.click(); await new Promise(r=>setTimeout(r,2000)); } const on=document.querySelector('.settings-tab-on'); return 'active:'+(on?on.textContent:'none');" \
        "0"
      ;;
    settings-prefs)
      # 偏好页是「默认模型由用户自选」这条改动的落点：候选来自模型目录、
      # 首项是「跟随内核默认」、推理档位同样从目录里出。
      # 末尾回读两个下拉的当前值作为回执 —— 只截图不回读的话，
      # 「下拉是空白的」与「下拉里只有一项」在图上不容易区分。
      run_scene "ui-settings-prefs" ".settings-tabs" \
        "$RAIL_HELPER await openRail('设置'); const t=[...document.querySelectorAll('.settings-tab')].find(x=>x.textContent.includes('偏好')); if(!t) return 'no-prefs-tab'; t.click(); await new Promise(r=>setTimeout(r,1200)); const sels=[...document.querySelectorAll('.page-body select')]; const labels=[...document.querySelectorAll('.page-body .modal-label')].map(x=>x.textContent); const mi=labels.indexOf('新建会话的默认模型'); const ei=labels.indexOf('默认推理档位'); const m=mi>=0?sels[mi]:null; const e=ei>=0?sels[ei]:null; return 'model:'+(m?m.value||'(跟随)':'none')+' options:'+(m?m.options.length:0)+' effort:'+(e?e.options.length:'none');" \
        "0"
      ;;
    skills)
      # 技能必须走真实安装路径预置（含审计），而不是手工摆文件 ——
      # 否则画面证明的只是「面板会渲染我塞的 JSON」，而不是「装好的技能真的会出现在这里」。
      # 脚本末尾回读面板里的技能名作为回执：点开了但没列出技能时日志里看得见。
      run_scene "ui-skills" ".skill-item" \
        "$RAIL_HELPER await openRail('技能'); const n=document.querySelector('.skill-name'); return n ? 'skill:'+n.textContent : 'no-skill-item';" \
        "0" \
        "DEEPWORK_HOME='$HOME_WIN' node -e \"const {SkillStore}=require('$REPO/packages/core-host/dist/skills/store'); const r=new SkillStore().install('$REPO/tools/fixtures/demo-skill'); if(!r.ok){console.error(r.reason);process.exit(1)}\""
      ;;
    memory)
      # 记忆必须走真实写入路径预置（memory.setProfile / memory.add），而不是手工摆文件 ——
      # 否则画面证明的只是「面板会渲染我塞的 JSON」，而不是「写下的记忆真的会出现在这里」。
      # 脚本末尾回读面板里的条目文本作为回执：点开了但没列出条目时日志里看得见。
      run_scene "ui-memory" ".memory-entry" \
        "$RAIL_HELPER await openRail('记忆'); const t=[...document.querySelectorAll('.settings-tab')].find(x=>x.textContent.includes('用户级')); if(!t) return 'no-tab'; t.click(); await new Promise(r=>setTimeout(r,800)); const e=document.querySelector('.memory-entry-text'); return e ? 'entry:'+e.textContent.slice(0,14) : 'no-entry';" \
        "0" \
        "DEEPWORK_HOME='$HOME_WIN' node -e \"const {MemoryStore}=require('$REPO/packages/core-host/dist/memory/store'); const s=new MemoryStore(); s.setProfile('后端工程师，回答用中文，偏好简洁直接的结论。'); s.add('user','所有项目的提交信息用中文书写。'); s.add('user','依赖安装一律走 npmmirror。'); s.add('workspace','demo 工作区：演示脚本三步链，截图前必须先重置 fixture。',{workspace:'$WORKSPACE_WIN'});\""
      ;;
    schedule)
      # 定时任务必须走真实 schedule store 预置，而不是手工摆 JSON ——
      # 否则画面证明的只是「面板会渲染我塞的数据」，而不是「加好的任务真的会出现在这里」。
      # 脚本末尾回读面板里的任务标题作为回执。
      run_scene "ui-schedule" ".schedule-item" \
        "$RAIL_HELPER await openRail('自动化'); const t=document.querySelector('.schedule-title'); return t ? 'task:'+t.textContent : 'no-task';" \
        "0" \
        "DEEPWORK_HOME='$HOME_WIN' node -e \"const {ScheduleStore}=require('$REPO/packages/core-host/dist/scheduler/store'); const s=new ScheduleStore(); s.add({title:'每周晨会纪要',prompt:'汇总最近一次的提交记录与工作区变动，生成晨会纪要写入 NOTES.md',workspace:'$WORKSPACE_WIN',spec:{kind:'weekly',weekdays:[1,3,5],time:'09:00'}});\""
      ;;
    connectors)
      # 连接器必须走真实清单路径预置（ConnectorStore），而不是手工摆 JSON ——
      # 否则画面证明的只是「面板会渲染我塞的数据」，而不是「清单里的记录真的会出现在这里」。
      # 脚本末尾回读面板里的连接器名称作为回执。mock 内核下「连接器不生效」提示应可见。
      run_scene "ui-connectors" ".connector-name" \
        "$RAIL_HELPER await openRail('连接器'); const n=document.querySelector('.connector-name'); return n ? 'connector:'+n.textContent : 'no-connector';" \
        "0" \
        "DEEPWORK_HOME='$HOME_WIN' node -e \"const {ConnectorStore}=require('$REPO/packages/core-host/dist/mcp/store'); const s=new ConnectorStore(); s.add({name:'fs-local',command:'npx',args:['-y','@modelcontextprotocol/server-filesystem'],enabled:true});\""
      ;;
    usage)
      # 用量数据必须走真实存储路径预置（会话日志 + 事件），而不是手工摆 JSON ——
      # 否则画面证明的只是「面板会渲染我塞的数字」，而不是「聚合真的从会话日志里算出来」。
      # 末尾回读总量作为回执：数字全是 0 时日志里看得见，不会以「一张空图」的形式蒙混过去。
      run_scene "ui-usage" ".usage-chart" \
        "$RAIL_HELPER await openRail('用量'); const c=document.querySelector('.usage-card-value'); return c ? 'total:'+c.textContent : 'no-usage-card';" \
        "0" \
        "DEEPWORK_HOME='$HOME_WIN' node '$REPO/tools/fixtures/seed-usage.js' '$WORKSPACE_WIN'"
      ;;
    browser)
      # 浏览器场景必须走真实浏览器：面板上的「运行中 / 当前页 / 截图」三项
      # 全部来自宿主对真实进程的观察，摆一份假的端点文件只能证明
      # 「面板会渲染我塞的数据」。预置脚本真拉起浏览器、真导航、真截两张图，
      # 然后 shutdown 收净进程；场景里的画面由渲染层自己走一遍用户路径
      # （地址栏输入 → 点「打开」）产生，而不是脚本替用户摆好状态。
      # 系统里没有 Edge/Chrome 时跳过并出声（见脚本头部的 BROWSER_OK）。
      if [ "$BROWSER_OK" != "1" ]; then
        echo "   ! 未找到 Edge/Chrome，跳过 ui-browser 场景" >&2
        continue
      fi
      run_scene "ui-browser" ".browser-status" \
        "$RAIL_HELPER await openRail('浏览器'); const i=document.querySelector('.browser-url'); if(!i) return 'no-url-input'; const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i,'$BROWSER_URL'); i.dispatchEvent(new Event('input',{bubbles:true})); await new Promise(r=>setTimeout(r,300)); const b=[...document.querySelectorAll('.browser-bar .btn')].find(x=>x.textContent.trim()==='打开'); if(!b) return 'no-open-btn'; b.click(); await new Promise(r=>setTimeout(r,7000)); const t=document.querySelector('.browser-current-title'); const shots=document.querySelectorAll('.browser-shot').length; return (t ? 'title:'+t.textContent : 'no-title') + ' shots:' + shots;" \
        "0" \
        "DEEPWORK_HOME='$HOME_WIN' node '$REPO/tools/fixtures/seed-browser.js' '$BROWSER_PAGE_WIN'"
      ;;
    office)
      # Office 场景**不走应用界面**：M2-I 的验收判据是「写出的文件能被真实办公软件
      # 打开」，所以证据只能出自 WPS 自己的窗口 —— 截我们自己的面板证明不了这件事。
      # 两步都是真的：seed-office.js 用真实生成器写出文档，
      # open-with-office.js 拉起真实 WPS 并按窗口标题抓它的窗口。
      if [ -z "$OFFICE_EXE" ]; then
        echo "   ! 未找到 WPS/Office，跳过 ui-office 场景" >&2
        continue
      fi
      echo "── 截图场景：ui-office（真实 WPS 打开生成的文档）"
      node "$REPO/tools/fixtures/seed-office.js" "$REPO/artifacts/office-demo" || {
        echo "   ! 预置 Office 演示产物失败" >&2
        continue
      }
      "$ELECTRON_MSYS" "$REPO/tools/open-with-office.js" "$REPO/artifacts/office-demo/report.docx" "$OUT_WIN/ui-office.png" 18
      "$ELECTRON_MSYS" "$REPO/tools/open-with-office.js" "$REPO/artifacts/office-demo/budget.xlsx" "$OUT_WIN/ui-office-sheet.png" 16
      ;;
    *)
      echo "未知场景：$scene" >&2
      ;;
  esac
done

rm -f "$LOG"
echo "完成。产物目录：$OUT"
