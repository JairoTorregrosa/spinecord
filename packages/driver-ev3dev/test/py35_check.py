"""Checks that Python files hold nothing newer than Python 3.5, the Python of an EV3 on ev3dev-stretch.

usage: py35_check.py <file>...       every file, and the guard's source inside the bridge
       py35_check.py --self-test      shows that each construct it looks for is refused
Byte-compiles each file with this Python, then walks its syntax tree and tokens for what Python 3.5 cannot
parse: f-strings, the walrus, annotations (of a variable, an argument or a return), positional-only
parameters, underscores in numbers, match, except*, type parameters and aliases, async generators and
comprehensions, and names of the standard library added after 3.5 that this repository has used elsewhere.
ast.parse's feature_version cannot do this on a current Python: it goes no lower than 3.7. Prints one JSON
line: {"checked": [...], "problems": [...]}.
"""
import ast
import io
import json
import os
import py_compile
import shutil
import sys
import tempfile
import tokenize

# Names that a 3.5 standard library lacks: (module, attribute) or a module alone.
NEWER_MODULES = {"dataclasses", "secrets", "contextvars", "zoneinfo", "graphlib", "tomllib"}
NEWER_ATTRS = {("time", "monotonic_ns"), ("time", "time_ns"), ("time", "perf_counter_ns"), ("math", "isqrt"),
               ("math", "prod"), ("math", "dist"), ("math", "comb"), ("math", "perm"), ("shlex", "join"),
               ("os", "memfd_create"), ("os", "pidfd_open"), ("functools", "cached_property"),
               ("contextlib", "nullcontext"), ("subprocess", "CompletedProcess.check_returncode")}
NEWER_KEYWORDS = {"capture_output", "text"}       # subprocess.run(..., capture_output=, text=): 3.7


def problems_of(source, name):
    found = []
    try:
        tree = ast.parse(source, name)
    except SyntaxError as e:
        return ["%s:%s: does not parse: %s" % (name, e.lineno, e.msg)]

    def at(node, what):
        found.append("%s:%d: %s" % (name, getattr(node, "lineno", 0), what))

    for node in ast.walk(tree):
        kind = type(node).__name__
        if kind == "JoinedStr":
            at(node, "an f-string (3.6)")
        elif kind == "NamedExpr":
            at(node, "the walrus := (3.8)")
        elif kind == "AnnAssign":
            at(node, "a variable annotation (3.6)")
        elif kind in ("Match", "TryStar", "TypeAlias"):
            at(node, "%s (3.10 and later)" % kind)
        elif kind in ("FunctionDef", "AsyncFunctionDef", "Lambda"):
            args = node.args
            every = list(getattr(args, "posonlyargs", [])) + list(args.args) + list(args.kwonlyargs)
            every += [a for a in (args.vararg, args.kwarg) if a is not None]
            if getattr(args, "posonlyargs", []):
                at(node, "positional-only parameters (3.8)")
            if any(a.annotation is not None for a in every):
                at(node, "an annotated parameter (only comments may type a signature here)")
            if getattr(node, "returns", None) is not None:
                at(node, "a return annotation")
            if getattr(node, "type_params", []):
                at(node, "type parameters (3.12)")
            if kind == "AsyncFunctionDef" and any(type(n).__name__ in ("Yield", "YieldFrom") for n in ast.walk(node)):
                at(node, "an async generator (3.6)")
        elif kind == "ClassDef" and getattr(node, "type_params", []):
            at(node, "type parameters (3.12)")
        elif kind == "comprehension" and getattr(node, "is_async", 0):
            at(node, "an async comprehension (3.6)")
        elif kind == "Import":
            for a in node.names:
                if a.name.split(".")[0] in NEWER_MODULES:
                    at(node, "module %s is newer than 3.5" % a.name)
        elif kind == "ImportFrom":
            if (node.module or "").split(".")[0] in NEWER_MODULES:
                at(node, "module %s is newer than 3.5" % node.module)
        elif kind == "Attribute" and type(node.value).__name__ == "Name":
            if (node.value.id, node.attr) in NEWER_ATTRS:
                at(node, "%s.%s is newer than 3.5" % (node.value.id, node.attr))
        elif kind == "Call":
            for k in node.keywords:
                if k.arg in NEWER_KEYWORDS:
                    at(node, "keyword %s= of a call newer than 3.5" % k.arg)
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type == tokenize.NUMBER and "_" in tok.string:
            found.append("%s:%d: an underscore in the number %s (3.6)" % (name, tok.start[0], tok.string))
        if tok.type == tokenize.STRING:
            prefix = tok.string[:3].lower()
            if "f" in prefix.split("'")[0].split('"')[0]:
                found.append("%s:%d: an f-string (3.6)" % (name, tok.start[0]))
        if type(tok.type) is int and tokenize.tok_name.get(tok.type) == "FSTRING_START":
            found.append("%s:%d: an f-string (3.6)" % (name, tok.start[0]))
    return found


def check_files(paths):
    checked, problems = [], []
    scratch = tempfile.mkdtemp()
    for path in paths:
        try:
            py_compile.compile(path, doraise=True, cfile=os.path.join(scratch, "check.pyc"))
        except py_compile.PyCompileError as e:
            problems.append("%s: does not byte-compile: %s" % (path, e.msg))
        with io.open(path, encoding="utf-8") as f:
            source = f.read()
        checked.append(path)
        problems.extend(problems_of(source, path))
        # the guard's source is a string of the bridge, run by a second Python: it is checked as a file too
        tree = ast.parse(source, path)
        for node in ast.walk(tree):
            if type(node).__name__ == "Assign" and any(getattr(t, "id", None) == "GUARD_SOURCE" for t in node.targets):
                guard = eval(compile(ast.Expression(node.value), path, "eval"), {"GUARD_DEADMAN_MS": 250, "repr": repr})
                checked.append(path + ":GUARD_SOURCE")
                problems.extend(problems_of(guard, path + ":GUARD_SOURCE"))
    shutil.rmtree(scratch, ignore_errors=True)
    return {"checked": checked, "problems": problems}


SAMPLES = {
    "f-string": 'x = 1\ny = f"{x}"\n',
    "walrus": "if (n := 3) > 2:\n    pass\n",
    "annotated signature": "def f(a: int) -> int:\n    return a\n",
    "variable annotation": "x: int = 1\n",
    "underscore in a number": "x = 1_000\n",
    "positional-only": "def f(a, /):\n    return a\n",
    "newer module": "import dataclasses\n",
    "newer attribute": "import time\nt = time.monotonic_ns()\n",
    "newer keyword": "import subprocess\nsubprocess.run(['true'], capture_output=True)\n",
}


def self_test():
    """Every sample is refused, and a 3.5 file passes."""
    out = {}
    for label, src in SAMPLES.items():
        out[label] = len(problems_of(src, label)) > 0
    out["clean 3.5 code passes"] = problems_of("import os\nx = '%d' % 3\ndef f(a, *b, **c):\n    return a\n", "clean") == []
    return out


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        result = self_test()
        print(json.dumps(result, sort_keys=True))
        sys.exit(0 if all(result.values()) else 1)
    result = check_files(sys.argv[1:])
    print(json.dumps(result))
    sys.exit(1 if result["problems"] else 0)
