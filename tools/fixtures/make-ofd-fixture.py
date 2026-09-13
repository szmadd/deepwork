"""生成 OFD 测试样本（只用 Python 标准库）。

── 为什么要用 Python 生成，而不是用我们自己的 zip 写出器 ──────────────
读取器的可信度取决于「它读的是谁产出的包」。用自己写的 zip 打包、
再用自己写的 zip 解包，只能证明「这两段代码自洽」——
一旦真实 OFD 的打包方式（压缩方法、条目顺序、目录结构、甚至路径分隔符）
有一点点不同，测试就一条都拦不住。

于是用**完全独立的实现**产出样本：Python 的 `zipfile` 是另一个团队、
另一套代码路径的 zip 实现。它写出来的包能被读对，才说明读取器对接的是
**规范**而不是自己的习惯。

── 样本里刻意埋的东西 ────────────────────────────────────────────
1. **文档顺序 ≠ 阅读顺序**：行的书写顺序被打乱，TextObject 还带着正确的 X/Y。
   不按坐标排序的读取器会读出一份词序错乱的公文 —— 这条必须有断言。
2. **同一行被切成多个 TextCode**：中文片段之间不能补空格、英文片段之间要补。
   这是 smartJoin 的回归哨兵（「中华人民共和国」不能变成「中华 人民 共和国」）。
3. **XML 特殊字符**：正文里含 `&` `<` `>`，必须以实体形式写出、读回原文。
4. **数字实体标点**：`、` 写成 `&#12289;`，检验实体反解。
5. **批注（Annot）**：正文之外还有批注，**不应**出现在提取结果里。
6. **压缩与存储两种包**：deflate 与 store 各一份，两条解压路径都要过。
7. **裸 XML 的单文件 OFD**：不合规范形态但真实存在，读取器要能兜住。

用法：python tools/fixtures/make-ofd-fixture.py
产物：tools/fixtures/sample.ofd / sample-stored.ofd / sample-single.ofd / sample.expected.txt
"""

from __future__ import annotations

import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
NS = "http://www.ofdspec.org/2016"

# ── 语义内容（唯一事实来源）──────────────────────────────────────
# 每页是一串「行」；每行是若干片段。片段有两种写法：
#   (x, 文本)            —— 文本会被 XML 转义后写进包（常规路径）
#   (x, 文本, 原始 XML)   —— 直接用给出的字符串当 XML 内容（用来构造
#                           &#12289; 这类**数字实体**：我们要检验的是
#                           读取器能否把实体反解成「、」，而不是把字面量
#                           当成正文。转义函数当然不能替我们造这个形态）
# 每页的内容由这份数据算出（见 expected_text），OFD 的 XML 也由它渲染 ——
# 但渲染时会**打乱顺序**，这样「排序」才是被检验的那个能力。
PAGES: list[list[tuple[float, list[tuple]]]] = [
    [
        (25.0, [(20.0, "深边AI Work OFD 读取样例")]),
        (45.0, [(20.0, "第二行：坐标排序才是阅读顺序")]),
        (65.0, [(20.0, "片段一"), (45.0, "片段二"), (70.0, "片段三")]),
        (80.0, [(20.0, "Hello"), (40.0, "World")]),
        (95.0, [(20.0, "特殊字符 A & B <tag>")]),
        # 顿号以数字实体形式出现在 XML 里，读回来必须是「、」
        (110.0, [(20.0, "报价：￥1,234.50"), (95.0, "、含税", "&#12289;含税")]),
    ],
    [
        (30.0, [(20.0, "第二页标题")]),
        (50.0, [(60.0, "数值"), (20.0, "项目")]),  # 行内 X 顺序也刻意反着写
        (65.0, [(20.0, "计算值"), (60.0, "42")]),
    ],
]

# 批注文本：必须**不**出现在提取结果里
ANNOT_TEXT = "这是批注不应出现在正文里"


def is_cjk(char: str) -> bool:
    """与 core-host/src/office/text.ts 的判据保持一致（中英混排连接规则的契约）"""
    code = ord(char)
    return (
        0x2E80 <= code <= 0x9FFF
        or 0xF900 <= code <= 0xFAFF
        or 0xFE30 <= code <= 0xFE4F
        or 0xFF00 <= code <= 0xFFEF
        or 0x3000 <= code <= 0x303F
    )


def smart_join(left: str, right: str) -> str:
    if not left:
        return right
    if not right:
        return left
    if is_cjk(left[-1]) or is_cjk(right[0]) or left[-1].isspace() or right[0].isspace():
        return left + right
    return left + " " + right


def expected_text() -> str:
    blocks = []
    for index, page in enumerate(PAGES, start=1):
        lines = []
        for _y, fragments in page:
            text = ""
            for fragment in sorted(fragments, key=lambda item: item[0]):
                text = smart_join(text, fragment[1])
            lines.append(text)
        body = "\n".join(lines)
        blocks.append(body if len(PAGES) == 1 else f"〔第 {index} 页〕\n{body}")
    return "\n\n".join(blocks)


def escape_xml(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def fragment_xml(fragment: tuple) -> str:
    """片段 → XML 内容：三元素形式表示调用方给的是**原始 XML**（如数字实体）"""
    if len(fragment) >= 3:
        return str(fragment[2])
    return escape_xml(fragment[1])


def content_xml(page: list[tuple[float, list[tuple[float, str]]]], with_annot: bool) -> str:
    """渲染一页的 Content.xml。

    关键：**行的书写顺序与阅读顺序相反**。按 XML 出现顺序取文本的读取器
    会得到一份倒着的文档，而正确答案只有一个（按 Y 升序、行内按 X 升序）。
    """
    objects: list[str] = []
    unit = 1
    for y, fragments in reversed(page):
        codes = []
        # 行内片段也倒着写进 XML：阅读顺序只能由 X 推出来，不能靠出现顺序
        for fragment in sorted(fragments, key=lambda item: -item[0]):
            x = fragment[0]
            codes.append(
                f'<ofd:TextCode X="{x}" Y="{y}" Font="1" Size="10.5">'
                f"{fragment_xml(fragment)}</ofd:TextCode>"
            )
        objects.append(
            f'<ofd:TextObject ID="{unit}" Boundary="20 {y - 8} 170 14">'
            f'{"".join(codes)}</ofd:TextObject>'
        )
        unit += 1

    # 批注：写在正文之外的独立结构里，读取器应当整块忽略
    annots = ""
    if with_annot:
        annots = (
            '<ofd:Annots><ofd:Annot ID="99" Type="Note" Boundary="20 250 40 10">'
            f'<ofd:TextObject ID="98"><ofd:TextCode X="20" Y="255" Size="9">'
            f"{escape_xml(ANNOT_TEXT)}</ofd:TextCode></ofd:TextObject>"
            "</ofd:Annot></ofd:Annots>"
        )

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<ofd:Page xmlns:ofd="{NS}">'
        '<ofd:Area><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:Area>'
        f"<ofd:Content><ofd:Layer ID=\"10\">{''.join(objects)}</ofd:Layer></ofd:Content>"
        f"{annots}"
        "</ofd:Page>"
    )


def build_parts() -> dict[str, str]:
    parts: dict[str, str] = {}

    parts["OFD.xml"] = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<ofd:OFD xmlns:ofd="{NS}" DocType="OFD" Version="1.0">'
        "<ofd:DocBody>"
        "<ofd:DocInfo><ofd:DocID>deepwork-fixture</ofd:DocID>"
        "<ofd:Creator>DeepWork fixture</ofd:Creator><ofd:CreatorVersion>1.0</ofd:CreatorVersion></ofd:DocInfo>"
        "<ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>"
        "<ofd:Versions><ofd:Version ID=\"1\"/></ofd:Versions>"
        "</ofd:DocBody></ofd:OFD>"
    )

    page_entries = "".join(
        f'<ofd:Page ID="{index}" BaseLoc="Pages/Page_{index - 1}/Content.xml"/>'
        for index in range(1, len(PAGES) + 1)
    )
    parts["Doc_0/Document.xml"] = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<ofd:Document xmlns:ofd="{NS}">'
        "<ofd:CommonData><ofd:MaxUnitID>100</ofd:MaxUnitID>"
        "<ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:PageArea>"
        '<ofd:PublicRes>PublicRes.xml</ofd:PublicRes>'
        '<ofd:DocumentRes>DocumentRes.xml</ofd:DocumentRes></ofd:CommonData>'
        f"<ofd:Pages>{page_entries}</ofd:Pages>"
        "</ofd:Document>"
    )

    parts["Doc_0/PublicRes.xml"] = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<ofd:Res xmlns:ofd="{NS}" BaseLoc="Res">'
        "<ofd:Fonts>"
        '<ofd:Font ID="1" FontName="宋体" FamilyName="宋体"/>'
        '<ofd:Font ID="2" FontName="黑体" FamilyName="黑体"/>'
        "</ofd:Fonts></ofd:Res>"
    )
    parts["Doc_0/DocumentRes.xml"] = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<ofd:Res xmlns:ofd="{NS}" BaseLoc="Res"></ofd:Res>'
    )

    for index in range(1, len(PAGES) + 1):
        parts[f"Doc_0/Pages/Page_{index - 1}/Content.xml"] = content_xml(PAGES[index - 1], index == 1)

    return parts


def write_zip(path: str, parts: dict[str, str], compression: int) -> None:
    # 条目顺序照写（真实 OFD 常见顺序：OFD.xml 在最前）
    with zipfile.ZipFile(path, "w", compression) as archive:
        for name, text in parts.items():
            archive.writestr(name, text.encode("utf-8"))


def main() -> None:
    parts = build_parts()

    write_zip(os.path.join(HERE, "sample.ofd"), parts, zipfile.ZIP_DEFLATED)
    write_zip(os.path.join(HERE, "sample-stored.ofd"), parts, zipfile.ZIP_STORED)

    # 裸 XML 的单文件形态：只保留第一页，内容里直接是 TextCode
    single = '<?xml version="1.0" encoding="UTF-8"?>\n' + (
        f'<ofd:Page xmlns:ofd="{NS}">'
        + content_xml(PAGES[0], False).split("?>", 1)[1]
    )
    with open(os.path.join(HERE, "sample-single.ofd"), "w", encoding="utf-8") as handle:
        handle.write(single)

    expected = expected_text()
    with open(os.path.join(HERE, "sample.expected.txt"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(expected + "\n")

    print(f"sample.ofd         {os.path.getsize(os.path.join(HERE, 'sample.ofd'))} B (deflate)")
    print(f"sample-stored.ofd  {os.path.getsize(os.path.join(HERE, 'sample-stored.ofd'))} B (store)")
    print(f"sample-single.ofd  {os.path.getsize(os.path.join(HERE, 'sample-single.ofd'))} B (裸 XML)")
    print(f"期望提取文本 {len(expected)} 字符 / {len(PAGES)} 页")


if __name__ == "__main__":
    main()
