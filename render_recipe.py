#!/usr/bin/env python3
"""Render a recipe JSON tree as a Cooking-for-Engineers style nested table.

The recipe is modelled as a tree: leaves are ingredients (top to bottom, in the
order they appear in the table), internal nodes are operations that combine
everything beneath them. Each operation sits one column to the right of its
deepest child, spanning the rows of all its leaves. Gaps left by shallower
branches are filled with borderless spacer cells.

Post-order traversal of that tree is the order a cook works in, so operations
are numbered as stages here and the page's script can walk them.

Usage:
    python3 render_recipe.py recipes/foo.json -o recipes/foo.html
"""

import argparse
import html
import json
import pathlib
import sys

# ---------------------------------------------------------------- tree layout


def annotate(node, counter):
    """Attach leaf range and column index to every node, bottom up."""
    if "item" in node:
        i = counter[0]
        counter[0] += 1
        node["_first"] = node["_last"] = i
        node["_col"] = 0
        return
    children = node.get("children") or []
    if not children:
        raise ValueError(f"operation {node.get('op')!r} has no children")
    for child in children:
        annotate(child, counter)
    node["_first"] = children[0]["_first"]
    node["_last"] = children[-1]["_last"]
    node["_col"] = max(c["_col"] for c in children) + 1


def collect(node, ops, items):
    if "item" in node:
        items.append(node)
    else:
        ops.append(node)
        for child in node["children"]:
            collect(child, ops, items)


def post_order_ops(node, out):
    """Operations in the order they are performed: every input ready first."""
    if "item" in node:
        return
    for child in node["children"]:
        post_order_ops(child, out)
    out.append(node)


def layout(tree):
    """Return (rows, cols, cells) where cells are (r, c, rowspan, colspan, kind, node)."""
    annotate(tree, [0])
    ops, items = [], []
    collect(tree, ops, items)
    rows = len(items)
    cols = tree["_col"] + 1

    occupied = [[False] * cols for _ in range(rows)]
    cells = []

    def place(r, c, rowspan, colspan, kind, node):
        for rr in range(r, r + rowspan):
            for cc in range(c, c + colspan):
                if occupied[rr][cc]:
                    raise ValueError(f"cell collision at row {rr}, col {cc}")
                occupied[rr][cc] = True
        cells.append((r, c, rowspan, colspan, kind, node))

    for node in items:
        place(node["_first"], 0, 1, 1, "item", node)
    for node in ops:
        place(node["_first"], node["_col"], node["_last"] - node["_first"] + 1, 1, "op", node)

    # Fill the ragged gaps with the largest borderless rectangles available.
    for r in range(rows):
        c = 1
        while c < cols:
            if occupied[r][c]:
                c += 1
                continue
            end = c
            while end < cols and not occupied[r][end]:
                end += 1
            width = end - c
            rowspan = 1
            while r + rowspan < rows and all(
                not occupied[r + rowspan][cc] for cc in range(c, end)
            ):
                rowspan += 1
            place(r, c, rowspan, width, "gap", None)
            c = end

    cells.sort(key=lambda x: (x[0], x[1]))
    return rows, cols, cells


# ------------------------------------------------------------------- rendering


def esc(text):
    return html.escape(str(text), quote=False)


def esc_attr(text):
    return html.escape(str(text), quote=True)


def num(value):
    """Format a number the same way JS String() does, to keep the renderers in step."""
    rounded = round(float(value), 4)
    return f"{int(rounded)}" if rounded == int(rounded) else f"{rounded:g}"


def pct(value):
    return f"{round(value, 1):.1f}".rstrip("0").rstrip(".")


def quantity_attrs(node):
    """Machine-readable amounts, present only when the source stated them.

    The visible text stays verbatim; these let the page rescale it on request.
    """
    if not node.get("name") or node.get("amount") in (None, ""):
        return []
    attrs = [f'data-amount="{num(node["amount"])}"']
    if node.get("unit"):
        attrs.append(f'data-unit="{esc_attr(node["unit"])}"')
    if node.get("metric") not in (None, ""):
        attrs.append(f'data-metric="{num(node["metric"])}"')
        if node.get("metric_unit"):
            attrs.append(f'data-metric-unit="{esc_attr(node["metric_unit"])}"')
    attrs.append(f'data-name="{esc_attr(node["name"])}"')
    return attrs


def cell_html(kind, node, rowspan, colspan):
    attrs = []
    if rowspan > 1:
        attrs.append(f'rowspan="{rowspan}"')
    if colspan > 1:
        attrs.append(f'colspan="{colspan}"')
    if kind == "gap":
        attrs.append('class="gap"')
        return f"      <td {' '.join(attrs)}></td>"

    if kind == "item":
        attrs.append('class="ing ref"' if node.get("from") else 'class="ing"')
        attrs.append(f'data-row="{node["_first"]}"')
        attrs.extend(quantity_attrs(node))
        body = f'<span class="qty">{esc(node["item"])}</span>'
        if node.get("from"):
            body += f'<span class="note">from {esc(node["from"])}</span>'
        elif node.get("note"):
            body += f'<span class="note">{esc(node["note"])}</span>'
    else:
        attrs.append('class="op"')
        attrs.append(f'data-stage="{node["_stage"]}"')
        rows = ",".join(str(i) for i in range(node["_first"], node["_last"] + 1))
        attrs.append(f'data-rows="{rows}"')
        body = f'<span class="verb">{esc(node["op"])}</span>'
        if node.get("detail"):
            body += f'<span class="detail">{esc(node["detail"])}</span>'
    return f"      <td {' '.join(attrs)}>{body}</td>"


def ingredient_width(ops):
    """Ingredient names are the long text, operation labels are short — so the
    ingredient column takes the larger share, giving ground as columns pile up."""
    return min(60.0, max(32.0, 64 - 4.5 * ops))


def colgroup_html(cols):
    """Fixed proportions: the ingredient column keeps its share no matter how
    long an operation's detail line runs."""
    ops = cols - 1
    if not ops:
        return '    <colgroup><col class="c-ing" style="width: 100%"></colgroup>'
    ing = ingredient_width(ops)
    parts = [f'<col class="c-ing" style="width: {pct(ing)}%">']
    each = pct((100 - ing) / ops)
    parts.extend(f'<col style="width: {each}%">' for _ in range(ops))
    return "    <colgroup>" + "".join(parts) + "</colgroup>"


def rows_html(rows, cols, cells):
    by_origin = {(r, c): (rs, cs, kind, node) for r, c, rs, cs, kind, node in cells}
    lines = [colgroup_html(cols)]
    for r in range(rows):
        lines.append("    <tr>")
        for c in range(cols):
            if (r, c) in by_origin:
                rs, cs, kind, node = by_origin[(r, c)]
                lines.append(cell_html(kind, node, rs, cs))
        lines.append("    </tr>")
    return "\n".join(lines)


def number_stages(tree, stage):
    """Stamp each operation with its position in the cooking sequence."""
    ordered = []
    post_order_ops(tree, ordered)
    for node in ordered:
        node["_stage"] = stage["n"]
        stage["n"] += 1


def band_rows(entries, cols, css_class, stage):
    out = []
    for entry in entries:
        text = entry if isinstance(entry, str) else entry.get("step", "")
        out.append(
            f'    <tr><td class="{css_class}" colspan="{cols}"'
            f' data-stage="{stage["n"]}">{esc(text)}</td></tr>'
        )
        stage["n"] += 1
    return "\n".join(out)


FIELD_ORDER = [
    ("serves", "serves"),
    ("yield", "yield"),
    ("vessel", "vessel"),
    ("oven", "oven"),
    ("active", "active"),
    ("time", "total time"),
    ("source", "source"),
]


def title_block(recipe):
    fields = []
    for key, label in FIELD_ORDER:
        value = recipe.get(key)
        if not value:
            continue
        if key == "source" and str(value).startswith("http"):
            host = str(value).split("/")[2]
            cell = f'<dd><a href="{esc_attr(value)}">{esc(host)}</a></dd>'
        elif key == "serves":
            # Marked up so rescaling can update it in place.
            cell = f'<dd data-serves="{num(value)}"><span class="serves">{num(value)}</span></dd>'
        else:
            cell = f"<dd>{esc(value)}</dd>"
        fields.append(f'      <div class="field"><dt>{esc(label)}</dt>{cell}</div>')
    if not fields:
        return ""
    return '    <dl class="block">\n' + "\n".join(fields) + "\n    </dl>"


LEGEND = (
    "Read across: every cell spans exactly the ingredients and earlier steps it "
    "combines, so the grid is the method."
)


def footer_html(recipe):
    notes = recipe.get("notes") or []
    parts = []
    if notes:
        cards = []
        for note in notes:
            if isinstance(note, str):
                cards.append(f'      <div class="note-item"><p>{esc(note)}</p></div>')
            else:
                title = note.get("title") or ""
                body = note.get("body") or ""
                heading = f"<h3>{esc(title)}</h3>" if title else ""
                cards.append(
                    f'      <div class="note-item">{heading}<p>{esc(body)}</p></div>'
                )
        parts.append('    <p class="label">notes</p>')
        parts.append('    <div class="note-grid">\n' + "\n".join(cards) + "\n    </div>")
    credit = f" {esc(recipe['credit'])}" if recipe.get("credit") else ""
    parts.append(f'    <p class="credit">{LEGEND}{credit}</p>')
    return "  <footer>\n" + "\n".join(parts) + "\n  </footer>"


CSS_PATH = pathlib.Path(__file__).resolve().parent / "extension" / "shared" / "recipe-table.css"
JS_PATH = CSS_PATH.with_name("interactive.js")


def load_css():
    """The stylesheet is shared verbatim with the browser extension."""
    return CSS_PATH.read_text(encoding="utf-8")


def load_js():
    """So is the script that adds scaling, cook mode, and cross-off."""
    return JS_PATH.read_text(encoding="utf-8")


def section_html(section, numbered, index, stage):
    tree = section["tree"]
    rows, cols, cells = layout(tree)
    # Stages run in the order they are performed: setup, then the operations in
    # post-order, then the trailing steps.
    prep = band_rows(section.get("prep") or [], cols, "prep", stage)
    number_stages(tree, stage)
    parts = []
    if prep:
        parts.append(prep)
    parts.append(rows_html(rows, cols, cells))
    finish = band_rows(section.get("finish") or [], cols, "finish", stage)
    if finish:
        parts.append(finish)
    min_width = f"calc(19rem + {cols - 1} * 5.5rem)"
    table = (
        '  <div class="scroll">\n'
        f'    <table style="min-width: {min_width}">\n'
        + "\n".join(parts)
        + "\n    </table>\n  </div>"
    )
    if not section.get("name"):
        return table
    tag = f'<span class="tag">{index}</span>' if numbered else ""
    return f'  <h2 class="section">{tag}{esc(section["name"])}</h2>\n{table}'


def article_html(recipe):
    """The sheet markup. Kept byte-identical to the extension's JS renderer —
    extension/shared/layout.js; tests/parity.py compares the two."""
    sections = recipe.get("sections") or [
        {k: v for k, v in recipe.items() if k in ("tree", "prep", "finish")}
    ]
    numbered = len(sections) > 1
    stage = {"n": 1}
    body = "\n".join(
        section_html(s, numbered, i + 1, stage) for i, s in enumerate(sections)
    )

    tags = recipe.get("tags") or []
    eyebrow = " · ".join(esc(t) for t in tags) if tags else "recipe table"
    deck = f'\n      <p class="deck">{esc(recipe["deck"])}</p>' if recipe.get("deck") else ""
    title = recipe.get("title", "Recipe")

    return f"""<article class="sheet">
  <header>
    <div class="titles">
      <p class="eyebrow">{eyebrow}</p>
      <h1>{esc(title)}</h1>{deck}
    </div>
{title_block(recipe)}
  </header>

{body}
{footer_html(recipe)}
</article>"""


def render(recipe):
    title = recipe.get("title", "Recipe")
    return f"""<title>{esc(title)} — recipe table</title>
<style>{load_css()}</style>

{article_html(recipe)}

<script>
{load_js()}</script>
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("recipe", help="path to recipe JSON")
    ap.add_argument("-o", "--out", help="output HTML path (default: alongside JSON)")
    args = ap.parse_args()

    with open(args.recipe, encoding="utf-8") as fh:
        recipe = json.load(fh)

    try:
        page = render(recipe)
    except ValueError as exc:
        sys.exit(f"error: {exc}")

    out = args.out or args.recipe.rsplit(".", 1)[0] + ".html"
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(page)
    print(out)


if __name__ == "__main__":
    main()
