#!/usr/bin/env python3
"""
Rebuild backend/public/index.html from "Ember & Oak.dc.html" without the original
design tool.

The compiled file is a bundler shell whose line 382 holds the ENTIRE inner document
as one JSON-escaped string. The shipped build is a backend-only production variant
that differs from the design source in a fixed set of ways (see DIVERGENCES below),
so the source is never copied in wholesale.

Safety: this script refuses to write unless `transform()` applied to the OLD source
reproduces the CURRENT compiled build byte-for-byte. That proves the divergence list
is still complete before any new content is trusted.

    python3 tools/rebuild-compiled.py --verify        # check only, no write
    python3 tools/rebuild-compiled.py --old <ref>     # rebuild (default ref: HEAD)

Run a syntax check afterwards (macOS, no Node required):
    osascript -l JavaScript /tmp/component.js
"""
import argparse, difflib, io, json, subprocess, sys

SRC = 'Ember & Oak.dc.html'
OUT = 'backend/public/index.html'
INNER_PREFIX = '"<!DOCTYPE html>\\n'   # the inner-document string literal starts with this


def inner_line_index(lines):
    """Locate the inner-document line instead of hardcoding it — adding anything to
    the outer shell's <head> (favicons, meta tags) shifts its position."""
    hits = [i for i, l in enumerate(lines) if l.startswith(INNER_PREFIX)]
    if len(hits) != 1:
        raise SystemExit(f'expected exactly 1 inner-document line, found {len(hits)}')
    return hits[0]

MARK = '<script type="text/x-dc" data-dc-script'

# The one encoding that round-trips the original byte-for-byte. The '</' escaping is
# mandatory: without it the string would terminate its own <script> tag.
encode = lambda s: json.dumps(s, ensure_ascii=False).replace('</', '<\\u002F')

# ---- source -> compiled divergences (production, backend-only variant) -----------
DIVERGENCES = [
    ('<script type="text/x-dc" data-dc-script data-props=',
     '<script type="text/x-dc" data-dc-script="" data-props='),
    ('  USE_BACKEND = false;', '  USE_BACKEND = true;'),
    ("    if (!this.backendMode() || !this.state.token) { alert('Client Deliveries activate once your backend is deployed and you sign in. This is a preview of the layout.'); return; }\n", ''),
    ("""          this.backendMode()
            ? h('label', { style: { padding: '10px 18px', background: busy ? '#c89b78' : '#9e5423', color: '#fff', borderRadius: 999, fontSize: 13, fontWeight: 700, letterSpacing: '.04em', cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap' } },
                busy ? 'Uploading…' : '+ Upload',
                h('input', { type: 'file', multiple: true, accept: 'image/*,video/*', disabled: busy, style: { display: 'none' },
                  onChange: (e) => { const fs = Array.from(e.target.files || []); e.target.value = ''; this.backendUpload(key, fs); } }))
            : h('button', { onClick: () => this.openUploader(key), style: { padding: '10px 18px', background: '#9e5423', color: '#fff', border: 'none', borderRadius: 999, fontSize: 13, fontWeight: 700, letterSpacing: '.04em', cursor: 'pointer', whiteSpace: 'nowrap' } }, '+ Upload')),""",
     """          h('label', { style: { padding: '10px 18px', background: busy ? '#c89b78' : '#9e5423', color: '#fff', borderRadius: 999, fontSize: 13, fontWeight: 700, letterSpacing: '.04em', cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap' } },
            busy ? 'Uploading…' : '+ Upload',
            h('input', { type: 'file', multiple: true, accept: 'image/*,video/*', disabled: busy, style: { display: 'none' },
              onChange: (e) => { const fs = Array.from(e.target.files || []); e.target.value = ''; this.backendUpload(key, fs); } }))),"""),
    ("this.backendMode() ? this.backendDelete(it.publicId, it.resourceType) : alert('Delete activates once your backend is deployed. In this preview, remove photos from your Cloudinary Media Library.')",
     "this.backendDelete(it.publicId, it.resourceType)"),
    ('      cloudReady: false, setupNeeded:',
     '      cloudReady: this.cloudReady() && !this.backendMode(), setupNeeded:'),
    ('      demoAdmin: !this.backendMode(),\n', ''),
    ('</body>\n</html>\n', '\n\n</body></html>'),
]

# Template-level rewrites the compiler performs outside the component script.
# (It also rewrites onClick -> sc-camel-on-click on template elements.)
TEMPLATE_DROP = (
    '        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;'
    'background:#f1ebdf;border-radius:12px;padding:14px 20px;margin-top:8px">\n'
    '          <div style="font-size:15px;color:#5a4d43">Signed in as <strong>{{ clientName }}</strong></div>\n'
    '          <a href="#" sc-camel-on-click="{{ doLogout }}" style="font-size:13px;font-weight:700;letter-spacing:.04em">Sign out</a>\n'
    '        </div>\n')


def template_patches(old_tpl, new_tpl):
    """Edits made to the TEMPLATE half of the source (everything before the component
    script) must be carried into the compiled prefix too — the compiled template is
    not regenerated, because the compiler inlines fonts there. Derive them as a diff
    so ordinary markup edits propagate without hand-written anchors."""
    o, n = old_tpl.split('\n'), new_tpl.split('\n')
    patches = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, o, n).get_opcodes():
        if tag == 'equal':
            continue
        if tag == 'insert':
            if i1 == 0:
                raise SystemExit('template insert at file start is not supported')
            anchor = o[i1 - 1]
            patches.append((anchor + '\n', anchor + '\n' + '\n'.join(n[j1:j2]) + '\n'))
        elif tag == 'delete':
            patches.append(('\n'.join(o[i1:i2]) + '\n', ''))
        else:
            patches.append(('\n'.join(o[i1:i2]), '\n'.join(n[j1:j2])))
    return patches


def apply_template_patches(prefix, patches):
    for old, new in patches:
        c = prefix.count(old)
        if c != 1:
            # the compiler rewrites some attributes (onClick -> sc-camel-on-click),
            # so a miss is reported rather than silently dropped
            print(f'  ! template patch skipped (matched {c}x): {old.strip()[:70]!r}')
            continue
        prefix = prefix.replace(old, new)
        print(f'  + template patch applied: {new.strip()[:70]!r}')
    return prefix


def transform(region):
    out = region
    for a, b in DIVERGENCES:
        n = out.count(a)
        if n != 1:
            raise SystemExit(f'divergence anchor matched {n}x (expected 1): {a[:70]!r}')
        out = out.replace(a, b)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--old', default='HEAD', help='git ref whose source matches the CURRENT build')
    ap.add_argument('--verify', action='store_true', help='verify only; do not write')
    args = ap.parse_args()

    lines = io.open(OUT, encoding='utf-8').read().split('\n')
    LINE = inner_line_index(lines)
    inner = json.loads(lines[LINE])

    old_src = subprocess.check_output(['git', 'show', f'{args.old}:{SRC}']).decode('utf-8')
    if transform(old_src[old_src.index(MARK):]) != inner[inner.index(MARK):]:
        raise SystemExit('ABORT: transform no longer reproduces the current build. '
                         'The divergence list is stale — update DIVERGENCES before rebuilding.')
    print('verified: transform reproduces the current build byte-for-byte')
    if args.verify:
        return

    new_src = io.open(SRC, encoding='utf-8').read()
    prefix = inner[:inner.index(MARK)]
    if prefix.count(TEMPLATE_DROP) == 1:
        prefix = prefix.replace(TEMPLATE_DROP, '')
    prefix = apply_template_patches(
        prefix, template_patches(old_src[:old_src.index(MARK)], new_src[:new_src.index(MARK)]))
    inner_new = prefix + transform(new_src[new_src.index(MARK):])

    lines[LINE] = encode(inner_new)
    io.open(OUT, 'w', encoding='utf-8').write('\n'.join(lines))
    print(f'rebuilt {OUT}: inner {len(inner)} -> {len(inner_new)} chars')


if __name__ == '__main__':
    main()
