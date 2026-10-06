#!/usr/bin/env python3
"""把系统里的 Noto Sans SC(OTF, SIL OFL)子集化到本项目用到的字符。

M1.5b 的字体资产复现脚本。输出 packages/pdf/assets/noto-sans-sc.subset.otf
（CFF-flavored OpenType，只含用到的字形）。

授权：Noto Sans SC 为 SIL Open Font License，可合法再分发与嵌入，故进仓库。
"""
from __future__ import annotations

import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "packages" / "pdf" / "assets" / "noto-sans-sc.subset.otf"
SRC_DEFAULT = Path(r"C:/Windows/Fonts/Noto Sans SC (TrueType).otf")


def char_set() -> set[int]:
    # 标题栏 / 尺寸 / 常用建筑词 + 数字字母标点
    cn = (
        "图名比例日期设计审核制图标建设单位工程名称项目专业阶段版本第页共"
        "单位毫米墙体轴线标高剖切立面平面楼梯门窗结构体筑水暖通风空调"
        "标注说明索引详图大样尺寸层数面积长宽高左右上下前后内外中东西南北"
        "方圆角混凝土木金属塑钢玻璃幕墙散水坡道台阶房间厨房卫生间阳台"
    )
    text = cn
    text += "0123456789"
    text += "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    text += "：:；;，,。.（）()/\\-—_·%×+"
    return {ord(c) for c in text}


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else SRC_DEFAULT
    if not src.exists():
        print(f"源字体不存在: {src}", file=sys.stderr)
        return 2
    chars = char_set()
    font = TTFont(str(src))
    ss = subset.Subsetter(options=subset.Options(glyph_names=False, recalc_bounds=True))
    ss.populate(unicodes=chars)
    ss.subset(font)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    font.save(str(OUT))
    # 校验：子集能打开、且字符都在
    out = TTFont(str(OUT))
    cmap = out.getBestCmap()
    missing = [chr(c) for c in chars if c not in cmap]
    print(f"源: {src}")
    print(f"出: {OUT}  ({OUT.stat().st_size} bytes)")
    print(f"字符数: {len(chars)}，子集缺字: {missing if missing else '无'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
