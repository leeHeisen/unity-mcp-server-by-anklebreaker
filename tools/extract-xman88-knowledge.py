#!/usr/bin/env python3
"""Regenerate src/data/xman88/{tool-guides,unity-knowledge}.json.

The payload is read out of a decompiled copy of the xman88 Unity MCP editor package
(`com.unitymcp.server/Editor/*.cs`). Point the script at that tree:

    python tools/extract-xman88-knowledge.py --source <path-to>/UnityMCP/UnityMCP/Editor

Everything the server ships at runtime is plain JSON produced by this script; the
decompiled sources are NOT part of this repository.
"""

import argparse
import io
import json
import os
import sys


class Ctor:
    __slots__ = ("type", "args", "members", "items")

    def __init__(self, type_name, args, members, items):
        self.type = type_name
        self.args = args
        self.members = members
        self.items = items


class Parser:
    """Parses the C# object-initializer subset used by the extracted data files."""

    def __init__(self, text):
        self.text = text
        self.pos = 0

    def error(self, msg):
        raise ValueError(f"{msg} at {self.pos}: {self.text[self.pos:self.pos + 60]!r}")

    def skip_ws(self):
        while self.pos < len(self.text) and self.text[self.pos] in " \t\r\n":
            self.pos += 1

    def peek(self, offset=0):
        return self.text[self.pos + offset : self.pos + offset + 1]

    def read_string(self):
        self.skip_ws()
        self.pos += 1  # opening quote
        out = []
        while True:
            if self.pos >= len(self.text):
                self.error("unterminated string")
            ch = self.text[self.pos]
            self.pos += 1
            if ch == "\\":
                esc = self.text[self.pos]
                self.pos += 1
                if esc == "u":
                    out.append(chr(int(self.text[self.pos : self.pos + 4], 16)))
                    self.pos += 4
                else:
                    out.append({"n": "\n", "r": "\r", "t": "\t", "0": "\0"}.get(esc, esc))
            elif ch == '"':
                return "".join(out)
            else:
                out.append(ch)

    def parse_value(self):
        self.skip_ws()
        ch = self.peek()
        if ch == '"':
            return self.read_string()
        if self.text.startswith("null", self.pos):
            self.pos += 4
            return None
        if self.text.startswith("true", self.pos):
            self.pos += 4
            return True
        if self.text.startswith("false", self.pos):
            self.pos += 5
            return False
        if self.text.startswith("new", self.pos) and not self.text[self.pos + 3].isalnum():
            return self.parse_new()
        if ch.isdigit() or ch == "-":
            start = self.pos
            while self.pos < len(self.text) and (self.text[self.pos].isdigit() or self.text[self.pos] in ".-fFuUlL"):
                self.pos += 1
            raw = self.text[start : self.pos]
            try:
                return int(raw)
            except ValueError:
                try:
                    return float(raw.rstrip("fFuUlL"))
                except ValueError:
                    return raw
        self.error("unsupported value")

    def _read_identifier(self):
        self.skip_ws()
        start = self.pos
        while self.pos < len(self.text) and (self.text[self.pos].isalnum() or self.text[self.pos] in "_.<>[]"):
            self.pos += 1
        if start == self.pos:
            self.error("expected identifier")
        return self.text[start : self.pos]

    def parse_new(self):
        self.pos += 3
        self.skip_ws()
        start = self.pos
        while self.pos < len(self.text) and self.text[self.pos] not in "{(":
            self.pos += 1
        type_name = self.text[start : self.pos].strip()
        self.skip_ws()
        args, members, items = [], {}, []

        if self.peek() == "(":
            self.pos += 1
            while True:
                self.skip_ws()
                if self.peek() == ")":
                    self.pos += 1
                    break
                args.append(self.parse_value())
                self.skip_ws()
                if self.peek() == ",":
                    self.pos += 1

        self.skip_ws()
        if self.peek() == "{":
            self.pos += 1
            while True:
                self.skip_ws()
                if self.peek() == "}":
                    self.pos += 1
                    break
                if self.peek() == "[":
                    self.pos += 1
                    key = self.parse_value()
                    self.skip_ws()
                    self.pos += 1  # ]
                    self.skip_ws()
                    self.pos += 1  # =
                    members[key] = self.parse_value()
                elif self.peek() == "{":
                    self.pos += 1
                    key = self.parse_value()
                    self.skip_ws()
                    if self.peek() == ",":
                        self.pos += 1
                    members[key] = self.parse_value()
                    self.skip_ws()
                    self.pos += 1  # }
                elif self.text.startswith("new", self.pos) and not self.text[self.pos + 3].isalnum():
                    items.append(self.parse_value())
                elif self.peek() == '"' or self.peek().isdigit() or self.peek() == "-":
                    items.append(self.parse_value())
                else:
                    name = self._read_identifier()
                    self.skip_ws()
                    if self.peek() == "=":
                        self.pos += 1
                        members[name] = self.parse_value()
                    else:
                        items.append(name)
                self.skip_ws()
                if self.peek() == ",":
                    self.pos += 1
        return Ctor(type_name, args, members, items)


def balanced(text, start):
    depth, i, in_string = 0, start, False
    while i < len(text):
        ch = text[i]
        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
        i += 1
    raise ValueError("unbalanced braces")


def to_json(node):
    if isinstance(node, Ctor):
        if node.type.startswith("List") or node.type.endswith("[]"):
            return [to_json(v) for v in node.items]
        data = {k: to_json(v) for k, v in node.members.items()}
        if node.args:
            data["__args__"] = [to_json(a) for a in node.args]
        return data
    if isinstance(node, list):
        return [to_json(v) for v in node]
    return node


def parse_dictionary(text, decl_marker, type_name):
    idx = text.find(decl_marker)
    if idx < 0:
        return {}
    brace = text.find("{", idx + len(decl_marker))
    body = balanced(text, brace)
    return to_json(Parser("new Dictionary<string, %s>%s" % (type_name, body)).parse_value())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="UnityMCP/UnityMCP/Editor directory of the decompiled package")
    ap.add_argument("--out", default=os.path.join("src", "data", "xman88"))
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    guides = {}
    for dirpath, _dirs, files in os.walk(args.source):
        for name in sorted(files):
            if not name.endswith(".cs"):
                continue
            text = io.open(os.path.join(dirpath, name), encoding="utf-8").read()
            if "public Dictionary<string, ToolGuideData> GetToolGuides ()" not in text:
                continue
            ret = text.find("return new Dictionary<string, ToolGuideData>")
            if ret < 0:
                continue
            body = balanced(text, text.find("{", ret + len("return new Dictionary<string, ToolGuideData>")))
            guides[name[:-3]] = to_json(Parser("new Dictionary<string, ToolGuideData>" + body).parse_value())

    with io.open(os.path.join(args.out, "tool-guides.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(guides, fh, ensure_ascii=False, indent=1)

    ktext = io.open(os.path.join(args.source, "ToolsV2", "KnowledgeData.cs"), encoding="utf-8").read()
    rules_marker = "public static string GetUIDesignRules ()"
    rules_idx = ktext.find(rules_marker)
    ui_rules = ""
    if rules_idx >= 0:
        rules_ret = ktext.find("return ", rules_idx) + len("return ")
        ui_rules = Parser(ktext[rules_ret:]).parse_value()

    knowledge = {
        "components": parse_dictionary(ktext, "public static readonly Dictionary<string, ComponentInfo> Components =", "ComponentInfo"),
        "layoutPatterns": parse_dictionary(ktext, "public static readonly Dictionary<string, LayoutPattern> LayoutPatterns =", "LayoutPattern"),
        "anchorPresets": parse_dictionary(ktext, "public static readonly Dictionary<string, AnchorPreset> AnchorPresets =", "AnchorPreset"),
        "uiDesignRules": ui_rules,
    }
    with io.open(os.path.join(args.out, "unity-knowledge.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(knowledge, fh, ensure_ascii=False, indent=1)

    print("categories: %d, guides: %d" % (len(guides), sum(len(v) for v in guides.values())))
    print(
        "components: %d, layoutPatterns: %d, anchorPresets: %d, uiRules: %d chars"
        % (len(knowledge["components"]), len(knowledge["layoutPatterns"]), len(knowledge["anchorPresets"]), len(ui_rules))
    )


if __name__ == "__main__":
    sys.exit(main())
