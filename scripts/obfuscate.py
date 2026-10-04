#!/usr/bin/env python3
"""
obfuscate.py  —  Post-build hardening pass on Bypass_Shortlinks.user.js

The ==UserScript== header is never modified (required by userscript managers).
All passes apply to the body only.

Every pass is JavaScript-string-aware: the body is first run through a small
tokenizer (split_code_and_strings / scan_js) that classifies every character
as code / string / template literal / regex literal / comment. Transforms are
only applied to the regions where they are provably safe, so they can never
chop a `//...` out of a URL inside a string, or truncate an arrow function
that merely *contains* a console call.

Techniques applied (in order):
  1. Comment strip        remove // and /* */ comments (only outside literals;
                          block comments become a single space so adjacent
                          tokens never fuse)
  2. Log strip            remove ONLY full standalone `console.*(...)` /
                          `_log(...)` statement lines — never a call embedded
                          in a larger expression
  3. Symbol mangle        rename internal names to short opaque aliases
                          (word-boundary replaces; identifier -> identifier is
                          syntax-safe everywhere, and keeps bracket-access
                          strings consistent)
  4. String fragmentation split recognizable string literals (whole literals
                          only) into joined char chunks
                          (seed-based: each build produces different splits)
  5. Char-code encode     encode remaining selector string literals as
                          charCode arrays decoded via String.fromCharCode —
                          no eval() used
  6. Dead code injection  insert inert code blocks ONLY at verified statement
                          boundaries (never inside a multi-line literal)
  7. Whitespace collapse  remove excess blank lines and trailing spaces

Hard safety gate (before anything is written):
  - `node --check` on the final output in a temp file (when node is available)
  - otherwise a tokenizer-based sanity check: no unterminated
    string/template/regex/comment at EOF and balanced brackets in code
  - plus, always: the number of string-literal `https://` occurrences must
    not shrink (catches chopped URLs)
If any check fails, the target file is NOT overwritten; an error is printed
and the script exits with code 1.

None of these techniques prevent the script from working. They prevent
site owners from grepping for their own selector names, IDs, class names,
or hostnames to find and patch bypass logic.
"""

import sys, os, re, random, hashlib, shutil, subprocess, tempfile
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

ROOT   = Path(__file__).resolve().parent.parent
TARGET = ROOT / 'Bypass_Shortlinks.user.js'


def _seed(code):
    h = hashlib.sha256(code.encode()).hexdigest()
    random.seed(int(h[:12], 16))


# ── 0. Minimal JavaScript tokenizer (string-awareness helper) ────────────────
# Segment kinds. Every character of the source belongs to exactly one segment.
K_CODE    = 0   # real code (includes the ${ ... } expressions of templates)
K_SQ      = 1   # '...' string literal
K_DQ      = 2   # "..." string literal
K_TPL     = 3   # `...` template-literal text (backticks, ${ and } markers)
K_REGEX   = 4   # /.../ regex literal (heuristic detection)
K_COMMENT = 5   # // line comment or /* ... */ block comment

# Keywords after which a `/` starts a regex literal rather than division.
_REGEX_KEYWORDS = frozenset((
    'return', 'case', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
    'void', 'throw', 'do', 'else', 'yield', 'await',
))
# Punctuation after which a `/` starts a regex literal rather than division.
_REGEX_PUNCT = frozenset('([{,;=:!&|?+-*%~^<>')


def scan_js(text):
    """Classify every character of JavaScript source.

    Returns (kinds, clean):
      kinds  list[int] — one K_* value per character of `text`
      clean  bool      — False when the scan ended inside an unterminated
                         string, template literal or block comment.

    Accuracy notes (no AST needed — just honest ranges of literal vs code):
      - '…' / "…" strings with backslash escapes (incl. backslash-newline)
      - template literals, incl. nested ${…} expressions and nested templates
      - regex literals with a standard lookahead heuristic: a `/` starts a
        regex when the previous significant token is an operator, opening
        bracket or expression keyword (return, typeof, ...); after an
        identifier, number, string, `)` or `]` it is division
      - character classes [...] inside regexes, where `/` does not terminate
      - both comment styles; `#!` shebang lines
    """
    n = len(text)
    kinds = [K_CODE] * n
    clean = True

    def is_word(c):
        return c == '_' or c == '$' or c.isalnum()

    i = 0
    in_tpl     = False   # currently scanning template-literal *text*
    tpl_depths = []      # brace depth of each open ${ ... } expression
    prev_sig   = ''      # last significant char seen in a code context
    prev_word  = ''      # last identifier-ish word seen in a code context

    # shebang line (if any) — treat as a comment
    if text.startswith('#!'):
        j = text.find('\n')
        j = n if j == -1 else j
        for k in range(j):
            kinds[k] = K_COMMENT
        i = j

    while i < n:
        if in_tpl:
            # template-literal text: scan to ` (end) or ${ (expression start)
            j = i
            while j < n:
                ch = text[j]
                if ch == '\\':
                    kinds[j] = K_TPL
                    if j + 1 < n:
                        kinds[j + 1] = K_TPL
                    j += 2
                    continue
                if ch == '`':
                    kinds[j] = K_TPL
                    j += 1
                    in_tpl = False
                    prev_sig, prev_word = '`', ''
                    break
                if ch == '$' and j + 1 < n and text[j + 1] == '{':
                    kinds[j] = K_TPL
                    kinds[j + 1] = K_TPL
                    j += 2
                    tpl_depths.append(0)
                    in_tpl = False
                    prev_sig, prev_word = '{', ''   # expression position
                    break
                kinds[j] = K_TPL
                j += 1
            else:
                clean = False        # ran into EOF inside template text
            i = j
            continue

        c = text[i]

        # ── comments ────────────────────────────────────────────────────────
        if c == '/' and i + 1 < n and text[i + 1] == '/':
            j = text.find('\n', i)
            if j == -1:
                j = n
            for k in range(i, j):
                kinds[k] = K_COMMENT
            i = j
            continue
        if c == '/' and i + 1 < n and text[i + 1] == '*':
            j = text.find('*/', i + 2)
            if j == -1:
                j = n
                clean = False
            else:
                j += 2
            for k in range(i, j):
                kinds[k] = K_COMMENT
            i = j
            continue

        # ── regex literal (heuristic) ───────────────────────────────────────
        # `}` allows a regex: a statement-starting /.../ after a closing
        # brace is common (`}\n/foo/.test(url) ? ... : null;`), whereas
        # division on an object literal (`{a:1} / 2`) does not occur in
        # practice. `)` stays division: `(a + b) / 2` is common.
        if (c == '/' and prev_sig in _REGEX_PUNCT) or \
           (c == '/' and prev_sig == '}') or \
           (c == '/' and prev_word in _REGEX_KEYWORDS) or \
           (c == '/' and prev_sig == ''):
            j = i + 1
            in_class    = False
            terminated  = False
            while j < n:
                ch = text[j]
                if ch == '\\':
                    j += 2
                    continue
                if ch == '\n':
                    break                       # raw newline: not a regex
                if in_class:
                    if ch == ']':
                        in_class = False
                elif ch == '[':
                    in_class = True
                elif ch == '/':
                    terminated = True
                    break
                j += 1
            if terminated and j < n:
                j += 1                          # closing slash
                while j < n and is_word(text[j]):
                    j += 1                      # flags
                for k in range(i, j):
                    kinds[k] = K_REGEX
                i = j
                prev_sig, prev_word = '/', ''
                continue
            # not actually a regex — fall through, treat `/` as plain code

        # ── string literals ─────────────────────────────────────────────────
        if c == "'" or c == '"':
            q = c
            j = i + 1
            while j < n:
                ch = text[j]
                if ch == '\\':
                    j += 2
                    continue
                if ch == q:
                    j += 1
                    break
                if ch == '\n':
                    clean = False               # unterminated string
                    break
                j += 1
            else:
                clean = False                   # EOF inside string
            if j > n:
                j = n
            kind = K_SQ if q == "'" else K_DQ
            for k in range(i, j):
                kinds[k] = kind
            i = j
            prev_sig, prev_word = q, ''
            continue

        # ── template literal entry ──────────────────────────────────────────
        if c == '`':
            kinds[i] = K_TPL
            in_tpl = True
            i += 1
            continue

        # ── brace tracking (for ${ ... } nesting) ───────────────────────────
        if c == '{':
            if tpl_depths:
                tpl_depths[-1] += 1
            prev_sig, prev_word = '{', ''
            i += 1
            continue
        if c == '}':
            if tpl_depths:
                if tpl_depths[-1] == 0:
                    tpl_depths.pop()            # closes a ${ ... }
                    kinds[i] = K_TPL
                    in_tpl = True
                    i += 1
                    continue
                tpl_depths[-1] -= 1             # block inside ${ ... }
            prev_sig, prev_word = '}', ''
            i += 1
            continue

        # ── identifiers / keywords ──────────────────────────────────────────
        if is_word(c):
            j = i
            while j < n and is_word(text[j]):
                j += 1
            # `foo.return / 2` — a word after '.' is a property, not a keyword
            prev_word = '' if (i > 0 and text[i - 1] == '.') else text[i:j]
            prev_sig = text[j - 1]
            i = j
            continue

        # ── stray backslash ─────────────────────────────────────────────────
        # Outside a literal a backslash can only belong to a mis-detected
        # regex literal; never let it fuse with a following '/' into a
        # phantom `//` comment.
        if c == '\\':
            i += 2 if i + 1 < n else 1
            continue

        if not c.isspace():
            prev_sig, prev_word = c, ''
        i += 1

    return kinds, clean


def split_code_and_strings(body):
    """Split JS source into (start, end, kind) segments.

    Returns (segments, clean) where segments cover the whole input in order
    and kind is one of the K_* values. `clean` is False when the scan ended
    inside an unterminated string/template/comment.
    """
    kinds, clean = scan_js(body)
    segs = []
    start = 0
    for idx in range(1, len(kinds) + 1):
        if idx == len(kinds) or kinds[idx] != kinds[start]:
            segs.append((start, idx, kinds[start]))
            start = idx
    return segs, clean


# ── 1. Strip comments ─────────────────────────────────────────────────────────
def strip_comments(body):
    """Remove // and /* */ comments — ONLY outside string/template/regex
    literals. Block comments are replaced by a single space so neighbouring
    tokens never fuse (`1/*x*/2` must not become `12`)."""
    kinds, _ = scan_js(body)
    out = []
    i, n = 0, len(body)
    while i < n:
        if kinds[i] != K_COMMENT:
            out.append(body[i])
            i += 1
            continue
        j = i
        while j < n and kinds[j] == K_COMMENT:
            j += 1
        if body[i:j].startswith('/*'):
            out.append(' ')
        i = j
    return ''.join(out)


# ── 2. Strip log calls ────────────────────────────────────────────────────────
_LOG_STARTERS = ('console.log', 'console.warn', 'console.error', 'console.info', '_log')

def _is_standalone_log_line(text, kinds, pos, line):
    """True when `line` (starting at `pos` in `text`) is exactly ONE complete
    statement whose whole expression is a console.*(...) / _log(...) call."""
    stripped = line.lstrip()
    starter = next((s for s in _LOG_STARTERS if stripped.startswith(s)), None)
    if starter is None:
        return False
    line_end = pos + len(line)

    # the call's opening paren must follow the starter, on this same line
    k = line_end - len(stripped) + len(starter)
    while k < line_end and text[k].isspace():
        k += 1
    if k >= line_end or text[k] != '(':
        return False

    # find the matching close paren — count only code characters, so parens
    # inside string/template/regex/comment literals are never miscounted
    depth = 0
    close = -1
    while k < line_end:
        if kinds[k] == K_CODE:
            ch = text[k]
            if ch == '(':
                depth += 1
            elif ch == ')':
                depth -= 1
                if depth == 0:
                    close = k
                    break
        k += 1
    if close == -1:
        return False

    # after the call: nothing but optional ';', whitespace, trailing comments
    k = close + 1
    while k < line_end:
        kd = kinds[k]
        if kd == K_COMMENT:
            k += 1
            continue
        ch = text[k]
        if kd == K_CODE and (ch == ';' or ch.isspace()):
            k += 1
            continue
        return False
    return True


def strip_logs(body):
    """Remove ONLY full standalone console.*(...) / _log(...) statement lines.

    A call embedded in a larger expression — `=> console.log(x)`,
    `.catch(e => console.error(e))`, `if (x) console.log(y);` — never matches
    and is always left intact. Removing a complete statement line is always
    syntax-preserving.
    """
    kinds, _ = scan_js(body)
    lines = body.split('\n')
    out = []
    pos = 0
    for line in lines:
        if not _is_standalone_log_line(body, kinds, pos, line):
            out.append(line)
        pos += len(line) + 1   # +1 for the '\n'
    return '\n'.join(out)


# ── 3. Symbol mangling ────────────────────────────────────────────────────────
SYMBOLS = {
    '_SETTINGS':         '_p0',
    '_BTN':              '_p1',
    '_NET':              '_p2',
    '_AAB':              '_p3',
    '_CNTDN':            '_p4',
    '_CAPTCHA':          '_p5',
    '_BAPI':             '_p6',
    '_cfg':              '_p7',
    '_HOST':             '_p8',
    '_URL':              '_p9',
    '_PATH':             '_pa',
    '_uw':               '_pb',
    'PROCEED_WORDS':     '_pc',
    '_captchaSolved':    '_pd',
    '_isReady':          '_pe',
    '_wasDisabled':      '_pf',
    'varZero':           '_pg',
    'domZero':           '_ph',
    'hookTimers':        '_pi',
    'hookDate':          '_pj',
    'seedDisabled':      '_pk',
    'waitForSolution':   '_pl',
    '_extractUrl':       '_pm',
    '_isExternal':       '_pn',
    '_solveMath':        '_po',
    '_solveDigitOrder':  '_pp',
    '_solveVisibleMath': '_pq',
    '_spoofGlobals':     '_pr',
    '_spoofFAB':         '_ps',
    '_spoofBaitGeometry':'_pt',
    '_blockAABScripts':  '_pu',
    '_blockAABRequests': '_pv',
    '_blockPopunders':   '_pw',
    '_scanDOM':          '_px',
    '_watchDOM':         '_py',
    '_dismiss':          '_pz',
    '_isWall':           '_p10',
    '_timerHooked':      '_p11',
    '_dateHooked':       '_p12',
    '_hooked':           '_p13',
    '_watching':         '_p14',
    '_destUrl':          '_p15',
    '_collapse':         '_p16',
    '_proceed':          '_p17',
    '_execute':          '_p18',
    '_toast':            '_p19',
    '_badge':            '_p1a',
    '_done':             '_p1b',
    '_obs':              '_p1c',
    '_poll':             '_p1d',
    '_elapsed':          '_p1e',
    '_fade':             '_p1f',
    '_go':               '_p1g',
}

def mangle_symbols(body):
    """Word-boundary replacement of known internal names.

    Kept whole-body (as before): replacing identifier-shaped text with other
    identifier-shaped text cannot break JS syntax anywhere, and mangling the
    same word inside string literals keeps bracket-access strings consistent
    with the renamed code symbols. Comments are already gone by the time this
    runs, and regex literals cannot be corrupted by identifier-for-identifier
    substitution.
    """
    for orig, repl in SYMBOLS.items():
        # Word-boundary replacement, skip strings already replaced
        body = re.sub(r'(?<![_a-zA-Z0-9$])' + re.escape(orig) + r'(?![_a-zA-Z0-9$])', repl, body)
    return body


# ── 4. String fragmentation ───────────────────────────────────────────────────
# Patterns that identify "greppable" strings worth fragmenting.
# Matches CSS selectors starting with # or ., and multi-word strings.
# Applied ONLY to whole single-quoted string literals found by the tokenizer,
# so a quote inside a "double-quoted" string can never be mistaken for the
# start of a literal.
_FRAG_CORE = re.compile(
    r"(?:#|\.)[a-zA-Z][a-zA-Z0-9_\-:.()]{3,}"                    # #id / .class selectors
    r"|[a-z][a-z0-9]{2,}\.(io|com|net|in|org|xyz|click|app|site|online)"  # hostnames
    r"|(?:free|get|start|create|slow|normal|generate|visit|access|click) [a-z ]{3,}"  # multi-word
)

def _chunk(s):
    parts, i = [], 0
    while i < len(s):
        size = random.randint(2, 4)
        parts.append(s[i:i + size])
        i += size
    inner = ','.join(f"'{p}'" for p in parts)
    return f"[{inner}].join('')"

def _rewrite_single_quote_literals(body, core_re, min_len, skip_chars, build):
    """Replace qualifying '...' string literals (whole literals only) via
    build(content). Everything else passes through untouched."""
    kinds, _ = scan_js(body)
    out = []
    i, n = 0, len(body)
    while i < n:
        if kinds[i] != K_SQ:
            out.append(body[i])
            i += 1
            continue
        j = i
        while j < n and kinds[j] == K_SQ:
            j += 1
        literal = body[i:j]
        replaced = False
        if len(literal) >= 2 and literal.endswith("'"):
            content = literal[1:-1]
            if len(content) >= min_len and core_re.fullmatch(content) \
                    and not any(c in content for c in skip_chars):
                out.append(build(content))
                replaced = True
        if not replaced:
            out.append(literal)
        i = j
    return ''.join(out)

def fragment_strings(body):
    def _repl(s):
        return _chunk(s)
    return _rewrite_single_quote_literals(
        body, _FRAG_CORE, 4, ('$', '{', '\\', '\n'), _repl)


# ── 5. Char-code encoding ─────────────────────────────────────────────────────
# Any remaining identifiable selector strings get encoded as charCode arrays.
# [65,66].map(function(c){return String.fromCharCode(c)}).join('') == 'AB'
# No eval() — pure map+fromCharCode. Whole single-quoted literals only.
_CHARCODE_CORE = re.compile(
    r"(?:#|\.)[a-zA-Z][a-zA-Z0-9_\-:.()]{5,}"    # #id or .class still in plaintext
    r"|input\[[^\]']{5,}\]"                       # attribute selectors
    r"|button[a-z .#\[\]\"=:]{5,}"                # button selectors
    r"|a\.[a-z][a-z\-]{5,}"                       # link selectors
)

def charcode_encode(body):
    def _enc(s):
        codes = ','.join(str(ord(c)) for c in s)
        return f"[{codes}].map(function(_c){{return String.fromCharCode(_c)}}).join('')"
    return _rewrite_single_quote_literals(
        body, _CHARCODE_CORE, 5, ('\\', '\n'), _enc)


# ── 6. Dead code injection ────────────────────────────────────────────────────
# Inert code blocks that look like normal shortlink page utility code.
# These obscure the real logic by adding visual noise. They are inserted ONLY
# after lines that provably end a statement (all bracket counters back to
# zero, line ends with ; { or }) and only when the next line starts in code —
# never inside a multi-line string/template literal or an open expression.

_DEAD = [
    'var _bspT=Date.now();void(_bspT>0);',
    '!function(){var _n=navigator.userAgent.length;void(_n);}();',
    'try{void(window.performance&&window.performance.now());}catch(_x){}',
    'var _bspR=!!document.querySelector;void(_bspR);',
    '!function(){var _m=Math.round;void(_m);}();',
    'try{void(Object.keys&&Object.keys({}).length===0);}catch(_x){}',
    'var _bspF=typeof window.fetch==="function";void(_bspF);',
    '!function(){var _d=document.readyState;void(_d);}();',
    'try{void(window.location&&window.location.protocol);}catch(_x){}',
    'var _bspH=window.history&&window.history.length;void(_bspH);',
]

def inject_dead_code(body):
    lines = body.split('\n')
    n = len(lines)
    if n < 40:
        return body
    kinds, _ = scan_js(body)

    safe = []                       # line indexes AFTER which insertion is safe
    bal_p = bal_b = bal_c = 0       # (), [], {} counters over code chars only
    pos = 0
    for idx, line in enumerate(lines):
        end = pos + len(line)
        last_code = ''
        for k in range(pos, end):
            if kinds[k] != K_CODE:
                continue
            ch = body[k]
            if ch == '(':
                bal_p += 1
            elif ch == ')':
                bal_p -= 1
            elif ch == '[':
                bal_b += 1
            elif ch == ']':
                bal_b -= 1
            elif ch == '{':
                bal_c += 1
            elif ch == '}':
                bal_c -= 1
            if not ch.isspace():
                last_code = ch
        if (0 < idx < n - 15
                and bal_p == 0 and bal_b == 0 and bal_c == 0
                and last_code in (';', '{', '}')
                and kinds[end + 1] == K_CODE):   # next line starts in real code
            safe.append(idx + 1)
        pos = end + 1

    if not safe:
        return body
    count = min(4, max(1, n // 25), len(safe))
    positions = sorted(random.sample(safe, count))
    for off, p in enumerate(positions):
        lines.insert(p + off, random.choice(_DEAD))
    return '\n'.join(lines)


# ── 7. Whitespace collapse ────────────────────────────────────────────────────
def collapse_whitespace(body):
    body = re.sub(r'\n{3,}', '\n\n', body)
    body = re.sub(r'[ \t]+\n', '\n', body)
    return body.strip()


# ── Safety gate ───────────────────────────────────────────────────────────────
def _node_available():
    return shutil.which('node') is not None


def _node_syntax_check(text):
    """Run `node --check` on `text` (written to a temp .js file).
    Returns (ok, diagnostics)."""
    fd, tmp_path = tempfile.mkstemp(suffix='.js', prefix='.obf_check_',
                                    dir=str(TARGET.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
        try:
            proc = subprocess.run(
                ['node', '--check', tmp_path],
                capture_output=True, text=True, encoding='utf-8',
                errors='replace', timeout=120,
            )
        except (OSError, subprocess.SubprocessError) as e:
            return False, f'node --check could not run: {e}'
        if proc.returncode == 0:
            return True, ''
        return False, (proc.stderr or proc.stdout or 'node --check failed').strip()
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def _sanity_check(text):
    """Tokenizer-based fallback syntax sanity check (used when node is not
    available). Returns (ok, reason)."""
    kinds, clean = scan_js(text)
    if not clean:
        return False, 'output ends inside an unterminated string/template/comment'
    p = b = c = 0
    for ch, k in zip(text, kinds):
        if k != K_CODE:
            continue
        if ch == '(':
            p += 1
        elif ch == ')':
            p -= 1
        elif ch == '[':
            b += 1
        elif ch == ']':
            b -= 1
        elif ch == '{':
            c += 1
        elif ch == '}':
            c -= 1
    if p or b or c:
        return False, (f'unbalanced brackets in code '
                       f'(parens {p:+d}, squares {b:+d}, braces {c:+d})')
    return True, ''


def _count_string_urls(text, needle='https://'):
    """Count `needle` occurrences that live INSIDE string/template literals."""
    kinds, _ = scan_js(text)
    count = 0
    idx = text.find(needle)
    while idx != -1:
        if kinds[idx] in (K_SQ, K_DQ, K_TPL):
            count += 1
        idx = text.find(needle, idx + 1)
    return count


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    if not TARGET.exists():
        print(f'  Target not found: {TARGET}')
        return

    code = TARGET.read_text(encoding='utf-8')

    # Split: header (untouched) | body (obfuscated)
    tag = '// ==/UserScript=='
    idx = code.find(tag)
    if idx == -1:
        print('  UserScript header not found — aborting')
        return
    idx = code.index('\n', idx) + 1
    header = code[:idx]
    body   = code[idx:]

    orig_len = len(code)
    urls_before = _count_string_urls(code)
    _seed(body)

    body = strip_comments(body)
    body = strip_logs(body)
    body = mangle_symbols(body)
    body = fragment_strings(body)
    body = charcode_encode(body)
    body = inject_dead_code(body)
    body = collapse_whitespace(body)

    result = header + '\n' + body + '\n'

    # ── Hard safety gate: never write corrupt output ────────────────────────
    node_diag = ''
    # (a) string-literal URLs must survive (always checked)
    urls_after = _count_string_urls(result)
    if urls_after < urls_before:
        print('  SAFETY CHECK FAILED — output NOT written; target untouched')
        print(f'    Reason: string-literal URLs lost: {urls_before} -> {urls_after}')
        sys.exit(1)

    # (b) full syntax check
    if _node_available():
        ok, node_diag = _node_syntax_check(result)
        checker = 'node --check'
    else:
        ok, node_diag = _sanity_check(result)
        checker = 'tokenizer sanity check'
    if not ok:
        print('  SAFETY CHECK FAILED — output NOT written; target untouched')
        print(f'    Reason: {checker} rejected the obfuscated output')
        for ln in node_diag.splitlines()[:15]:
            print(f'    {ln}')
        sys.exit(1)

    TARGET.write_text(result, encoding='utf-8')

    print(f'  Hardening done: {orig_len:,} → {len(result):,} chars ({TARGET.name})')


if __name__ == '__main__':
    main()
