#!/usr/bin/env python3
"""
生成前端用的 Material Symbols 图标字体子集

为什么要子集化：完整的可变图标字体有 3.9 MB，而应用实际只用了几十个图标。
首页一打开就要显示图标，在手机网络上不能为了几十个图标下载几 MB。子集后只有几十 KB。

做了什么：
  1. 扫描前端源码，找出用到的图标名（见下面 USED_ICON_PATTERNS）
  2. 把字体的可变轴收窄到应用实际用到的范围：FILL 0–1、wght 100–700，GRAD 固定 0、opsz 固定 24
     （和之前从 Google CDN 加载的 `wght,FILL` 版本一致，所以外观不变）
  3. 只保留这些图标对应的连字，输出 woff2
  4. 同时输出一份侧车文件 JSON：本次保留的图标 + 字体里全部合法图标名，供
     `scripts/check-icons.mjs` 在构建时检查「有没有用了图标却没进子集」

什么时候要重新运行：新增或修改了图标之后。构建时 check-icons 会检查，漏了会报错并提示运行本脚本。
    pip install -r scripts/requirements-icons.txt
    python3 scripts/build-icon-font.py        # 或者 npm run build:icons
"""
import json
import re
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
SOURCE_FONT = ROOT / 'node_modules/@fontsource-variable/material-symbols-outlined/files/material-symbols-outlined-latin-full-normal.woff2'
OUT_DIR = ROOT / 'src/assets/fonts'
OUT_FONT = OUT_DIR / 'material-symbols-outlined.subset.woff2'
OUT_META = OUT_DIR / 'material-symbols-outlined.subset.json'

SCAN_SUFFIXES = {'.ts', '.tsx', '.html'}
SKIP_DIRS = {'node_modules', 'dist', 'scripts', '.git'}

# 图标名只会以这两种形式出现在源码里：字符串字面量（'home' / "home" / `home`），
# 或 JSX 文本（>home<，允许前后有空白和换行）。三元表达式里的两个名字也都是字符串字面量。
USED_ICON_PATTERNS = [
    re.compile(r"""['"`]([a-z][a-z0-9_]*)['"`]"""),
    re.compile(r""">\s*([a-z][a-z0-9_]*)\s*<"""),
]


def source_files():
    for p in ROOT.rglob('*'):
        if p.is_file() and p.suffix in SCAN_SUFFIXES and not (set(p.relative_to(ROOT).parts) & SKIP_DIRS):
            yield p


def collect_candidates():
    found = set()
    for p in source_files():
        text = p.read_text(encoding='utf-8', errors='ignore')
        for pattern in USED_ICON_PATTERNS:
            found.update(pattern.findall(text))
    return found


def ligature_table(font):
    """返回 {图标名: 输出字形名}。图标名 = 连字的输入字符序列"""
    cmap = font.getBestCmap()
    glyph_to_char = {g: chr(c) for c, g in cmap.items() if c < 0x80}
    gsub = font['GSUB'].table
    ligatures = {}
    for lookup in gsub.LookupList.Lookup:
        for st in lookup.SubTable:
            st = getattr(st, 'ExtSubTable', st)
            for first, lig_list in getattr(st, 'ligatures', {}).items():
                for lg in lig_list:
                    comps = [first] + list(lg.Component)
                    if all(c in glyph_to_char for c in comps):
                        ligatures[''.join(glyph_to_char[c] for c in comps)] = lg.LigGlyph
    return ligatures


def main():
    if not SOURCE_FONT.exists():
        sys.exit(f'找不到源字体：{SOURCE_FONT}\n请先在 client/ 目录运行 npm install')

    font = TTFont(SOURCE_FONT)
    ligatures = ligature_table(font)
    known = sorted(ligatures)

    used = sorted(collect_candidates() & set(ligatures))
    if not used:
        sys.exit('没有扫描到任何图标名，请检查 USED_ICON_PATTERNS 是否还适用')

    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['rclt', 'rlig']   # 图标连字用的特性（这个字体里不是 liga）
    opts.layout_closure = False               # 必须关闭：否则所有连字都会被连带保留，子集就白做了
    opts.name_IDs = [1, 2, 3, 4, 6]
    opts.hinting = False
    opts.glyph_names = False
    opts.notdef_outline = True
    opts.drop_tables += ['STAT']

    chars = sorted({ch for name in used for ch in name})
    subsetter = subset.Subsetter(opts)
    subsetter.populate(glyphs=[ligatures[n] for n in used], unicodes=[ord(c) for c in chars])
    subsetter.subset(font)

    # 先子集、后收窄轴：反过来做时 fontTools 在 gvar 表上会报 KeyError（部分字形没有变体数据）
    # 收窄可变轴：和之前 Google CDN 的 wght,FILL 版本等价（opsz 默认 24，GRAD 默认 0）
    instancer.instantiateVariableFont(font, {'FILL': (0, 1), 'wght': (100, 700), 'GRAD': 0, 'opsz': 24}, inplace=True)


    OUT_DIR.mkdir(parents=True, exist_ok=True)
    font.flavor = 'woff2'
    font.save(OUT_FONT)

    OUT_META.write_text(json.dumps({
        '_说明': '由 scripts/build-icon-font.py 生成，不要手工编辑。icons = 本次子集包含的图标；known = 字体里全部合法图标名（供构建检查用）',
        'icons': used,
        'known': known,
    }, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')

    print(f'字体：{OUT_FONT.relative_to(ROOT)}  {OUT_FONT.stat().st_size / 1024:.1f} KB（完整字体 {SOURCE_FONT.stat().st_size / 1024:.0f} KB）')
    print(f'图标：{len(used)} 个')
    print('  ' + ', '.join(used))


if __name__ == '__main__':
    main()
