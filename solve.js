// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the output tree its build() returns.
// Same rules, restructured for speed: one pass over Markdown (no token array), chunked HTML escaping instead of
// per-character, array+join string building, per-run memoisation of slugify, and every cache created inside run().

const hasOwn = Object.hasOwn;

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
const escCb = (c) => ESCAPES[c];

/** `text` with & < > " ' escaped. */
function escapeHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, escCb) : text;
}

const SLUG_MAX = 64;
const MARK_RE = /\p{M}/gu;
const NON_ALNUM_RUN = /[^a-z0-9]+/g;

/** The slug rule, exactly (README "Text"), with an ASCII fast path (the NFKD path is not needed there). */
function slugifyRaw(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  let out;
  if (ascii) {
    // A-Z lowered, every run of other characters one "-", no "-" at either end.
    out = text.toLowerCase().replace(NON_ALNUM_RUN, '-');
    if (out.charCodeAt(0) === 45) out = out.slice(1);
    if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
    out = out.replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) { out += '-'; gap = false; }
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words. */
function longDate(date) {
  return `${+date.slice(8, 10)} ${MONTHS[+date.slice(5, 7) - 1]} ${date.slice(0, 4)}`;
}

// JavaScript's \s, as a table (a constant of the language, not of any case).
const WS_TEST = /\s/;
const WS = new Uint8Array(65536);
for (let c = 0; c < 65536; c++) {
  WS[c] = c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff ? 1 : 0;
}

/** A body's words: its runs of characters other than whitespace. */
function countWords(t) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < t.length; i++) {
    if (WS[t.charCodeAt(i)]) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- small line helpers

/** Spaces and tabs only. */
function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Spaces and tabs at both ends dropped. */
function trimBoth(s) {
  const n = s.length;
  let a = 0;
  while (a < n) { const c = s.charCodeAt(a); if (c !== 32 && c !== 9) break; a++; }
  if (a === n) return '';
  let b = n;
  while (b > a) { const c = s.charCodeAt(b - 1); if (c !== 32 && c !== 9) break; b--; }
  return a === 0 && b === n ? s : s.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence opening line's language, or null. */
function fenceLang(line) {
  const n = line.length;
  if (n < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < n && isLangChar(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  while (i < n) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return null; i++; }
  return lang;
}

function isFenceClose(line) {
  const n = line.length;
  if (n < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < n; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

function headingOf(line) {
  const n = line.length;
  let k = 0;
  while (k < n && line.charCodeAt(k) === 35) k++;
  if (k < 1 || k > 6 || k >= n) return null;
  const c0 = line.charCodeAt(k);
  if (c0 !== 32 && c0 !== 9) return null;
  let j = k;
  while (j < n) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) break; j++; }
  let e = n;
  while (e > j) { const c = line.charCodeAt(e - 1); if (c !== 32 && c !== 9) break; e--; }
  if (e === j) return null;
  return { depth: k, text: line.slice(j, e) };
}

function isHr(line) {
  const n = line.length;
  if (n < 3) return false;
  const a = line.charCodeAt(0);
  if (a === 45) {
    if (line.charCodeAt(1) !== 45 || line.charCodeAt(2) !== 45) return false;
  } else if (a === 42) {
    if (line.charCodeAt(1) !== 42 || line.charCodeAt(2) !== 42) return false;
  } else return false;
  for (let i = 3; i < n; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

/** The rest of a bullet item line, or null. */
function bulletRest(line) {
  if (line.length < 2) return null;
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item line's number and rest, or null. */
let orderedNum = 0;
function orderedRest(line) {
  const n = line.length;
  let i = 0;
  while (i < n && i < 10) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0 || i > 9) return null;
  if (i + 1 >= n || line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  orderedNum = +line.slice(0, i);
  return line.slice(i + 2);
}

function continued(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  return line.charCodeAt(2) !== 32 && line.charCodeAt(2) !== 9;
}

function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

// ---------------------------------------------------------------- inline Markdown

// The characters a backslash escapes: \ ` * _ [ ] ( ) # + - . ! >
function isEscapable(c) {
  switch (c) {
    case 92: case 96: case 42: case 95: case 91: case 93: case 40: case 41:
    case 35: case 43: case 45: case 46: case 33: case 62: return true;
  }
  return false;
}

function findUnescaped(s, what, from, n) {
  const m = what.length;
  for (let j = from; j <= n - m; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (c === what.charCodeAt(0) && s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/** The next character inline() must stop at, from `from`, or -1. */
const STOP_RE = /[\\`*[]/g;
function nextStop(s, from) {
  STOP_RE.lastIndex = from;
  const m = STOP_RE.exec(s);
  return m === null ? -1 : m.index;
}

/** `s` rendered inline; `link(target)` is a link's href. */
function inline(s, link) {
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    // a run of ordinary characters, escaped in one go
    const stop = nextStop(s, i);
    const j = stop === -1 ? n : stop;
    if (j > i) out += escapeHtml(s.slice(i, j));
    if (j >= n) break;
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
        out += escapeHtml(s[j + 1]);
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += '<code>' + escapeHtml(s.slice(j + 1, k)) + '</code>';
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, n);
        if (k > j + 2) {
          out += '<strong>' + inline(s.slice(j + 2, k), link) + '</strong>';
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        out += '<em>' + inline(s.slice(j + 1, k), link) + '</em>';
        i = k + 1;
      } else {
        out += '*';
        i = j + 1;
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', j + 1, n);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    if (m !== -1) {
      const target = s.slice(k + 2, m);
      if (target !== '' && !WS_TEST.test(target)) {
        out += '<a href="' + escapeHtml(link(target)) + '">' + inline(s.slice(j + 1, k), link) + '</a>';
        i = m + 1;
        continue;
      }
    }
    out += '[';
    i = j + 1;
  }
  return out;
}

/** `src` rendered: its HTML, its table of contents and its excerpt. `ctx` = { link, slug }. */
function renderMarkdown(src, ctx) {
  const link = ctx.link;
  const slugOf = ctx.slug;
  const lines = src.split('\n');
  const count = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < count) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      const parts = [];
      while (i < count && !isFenceClose(lines[i])) parts.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      let body = '';
      for (let k = 0; k < parts.length; k++) body += `${escapeHtml(parts[k])}\n`;
      blocks.push(`<pre><code${cls}>${body}</code></pre>`);
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugOf(h.text), ids);
      const html = inline(h.text, link);
      blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < count && lines[i].charCodeAt(0) === 62) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimBoth(t);
        if (t !== '') body.push(t);
        i++;
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(body.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const b0 = bulletRest(line);
    const o0 = b0 === null ? orderedRest(line) : null;
    if (b0 !== null || o0 !== null) {
      const isOrdered = o0 !== null;
      const start = isOrdered ? orderedNum : 1;
      const items = [];
      while (i < count) {
        const cur = lines[i];
        if (isOrdered) {
          const r = orderedRest(cur);
          if (r !== null) { items.push([trimBoth(r)]); i++; continue; }
        } else {
          const r = bulletRest(cur);
          if (r !== null) { items.push([trimBoth(r)]); i++; continue; }
        }
        if (continued(cur)) { items[items.length - 1].push(trimBoth(cur)); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let body = '';
      for (let k = 0; k < items.length; k++) {
        const item = items[k].length === 1 ? items[k][0] : items[k].join('\n');
        body += `<li>${inline(item, link)}</li>\n`;
      }
      blocks.push(`${open}\n${body}</${tag}>`);
      continue;
    }
    // paragraph
    let text = trimBoth(line);
    i++;
    while (i < count && !endsParagraph(lines[i])) { text += '\n' + trimBoth(lines[i]); i++; }
    const html = inline(text, link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (let k = 0; k < blocks.length; k++) html += blocks[k] + '\n';
  return { html, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    const n = raw.length;
    if (n < 2 || raw.charCodeAt(n - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < n - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === n - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          const c = raw.charCodeAt(i);
          if (i === 4 || i === 7) { if (c !== 45) { ok = false; break; } }
          else if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? +raw.slice(0, 4) : 0;
      const mo = ok ? +raw.slice(5, 7) : 0;
      const d = ok ? +raw.slice(8, 10) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      const n = raw.length;
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(n - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, n - 1);
      if (isBlank(inner)) return { value: [] };
      const tags = inner.split(',').map((t) => trimBoth(t));
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let k = 0; k < t.length; k++) {
          const c = t.charCodeAt(k);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      // ^[a-z0-9]+(?:-[a-z0-9]+)*$ and at most 64 characters
      let ok = raw.length > 0 && raw.length <= 64;
      if (ok) {
        let started = false;
        let prevDash = true;
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          const alnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
          if (alnum) { started = true; prevDash = false; continue; }
          if (c === 45 && !prevDash) { prevDash = true; continue; }
          ok = false;
          break;
        }
        if (ok && (prevDash || !started)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isKeyStart(c) { return (c >= 97 && c <= 122) || c === 95; }

/** A source's front matter and body: { data, body }, or { error }. `text` has "\n" line ends. */
function parseFrontMatter(text) {
  const n = text.length;
  let p = text.indexOf('\n');
  const firstLine = p === -1 ? text : text.slice(0, p);
  if (firstLine !== '---') return { error: 'no front matter' };
  // find the closing "---" line
  let ls = p === -1 ? n : p + 1;
  let closeLineEnd = -1;
  let bodyStart = -1;
  let lineNo = 1;
  for (;;) {
    if (ls > n) break;
    let le = text.indexOf('\n', ls);
    if (le === -1) le = n;
    if (le - ls === 3 && text.charCodeAt(ls) === 45 && text.charCodeAt(ls + 1) === 45 && text.charCodeAt(ls + 2) === 45) {
      closeLineEnd = ls;
      bodyStart = le < n ? le + 1 : n;
      break;
    }
    if (le === n) break;
    ls = le + 1;
    lineNo++;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const seen = new Set();
  // validate every line strictly before the closing "---"
  ls = p + 1;
  for (let idx = 1; ls < closeLineEnd; idx++) {
    let le = text.indexOf('\n', ls);
    if (le === -1 || le > closeLineEnd) le = closeLineEnd;
    const line = text.slice(ls, le);
    ls = le + 1;
    if (isBlank(line)) continue;
    if (line.charCodeAt(0) === 35) continue;
    let i = 0;
    while (i < line.length && isKeyStart(line.charCodeAt(i))) i++;
    if (i === 0 || i >= line.length || line.charCodeAt(i) !== 58) return { error: `line ${idx + 1} is not "key: value"` };
    const key = line.slice(0, i);
    const rest = line.slice(i + 1);
    let raw;
    if (rest === '') raw = '';
    else if (rest.charCodeAt(0) === 32) raw = rest.slice(1);
    else return { error: `line ${idx + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0) { const c = raw.charCodeAt(e - 1); if (c !== 32 && c !== 9) break; e--; }
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (seen.has(key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    seen.add(key);
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function TemplateError(message) { this.message = message; }
TemplateError.prototype = Object.create(Error.prototype);

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlank(src.slice(lineStart, open)) && isBlank(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  const tokens = tokenize(name, src);
  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti];
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  const first = path[0];
  let s = scope;
  while (s !== null && !hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  if (path.length === 1) return v;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) out += (i === 0 ? '' : ', ') + textOf(v[i]);
    return out;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// ---------------------------------------------------------------- the template compiler
//
// parseTemplate gives a tree; the tree is compiled once per run into one JavaScript function per template. The
// generated code resolves each path with a specialised lookup (1 or 2 names inline, longer paths by table), so a
// render is straight-line string building instead of a walk over node objects.

/** The scope chain lookups the generated code calls. */
const TPL_HELPERS = {
  hasOwn,
  LOOK1(s, a) {
    while (s !== null) {
      const v = s.vars;
      if (hasOwn(v, a)) return v[a];
      s = s.parent;
    }
    return undefined;
  },
  LOOK2(s, a, b) {
    while (s !== null) {
      const v = s.vars;
      if (hasOwn(v, a)) {
        const x = v[a];
        return x !== null && typeof x === 'object' && hasOwn(x, b) ? x[b] : undefined;
      }
      s = s.parent;
    }
    return undefined;
  },
  LOOKN: lookup,
  TXT: textOf,
  TRU: truthy,
  ES(v) {
    return escapeHtml(typeof v === 'string' ? v : textOf(v));
  },
  paths: [],
};

function compileTemplates(parsed, order) {
  const indexOf = new Map();
  for (let k = 0; k < order.length; k++) indexOf.set(order[k], k);
  const paths = [];
  const bodies = [];
  let seq = 0;

  const emit = (nodes, out, scopeVar) => {
    for (let k = 0; k < nodes.length; k++) {
      const n = nodes[k];
      const pathExpr = (path) => {
        if (path.length === 1) return `LOOK1(${scopeVar},${JSON.stringify(path[0])})`;
        if (path.length === 2) return `LOOK2(${scopeVar},${JSON.stringify(path[0])},${JSON.stringify(path[1])})`;
        paths.push(path);
        return `LOOKN(${scopeVar},P[${paths.length - 1}])`;
      };
      switch (n.kind) {
        case 'text':
          out.push(`out+=${JSON.stringify(n.text)};`);
          break;
        case 'var':
          out.push(`out+=ES(${pathExpr(n.path)});`);
          break;
        case 'raw':
          out.push(`out+=TXT(${pathExpr(n.path)});`);
          break;
        case 'if': {
          const t = `v${seq++}`;
          out.push(`{const ${t}=TRU(${pathExpr(n.path)});if(${n.not ? '!' : ''}${t}){`);
          emit(n.then, out, scopeVar);
          out.push('}');
          if (n.else !== null) {
            out.push('else{');
            emit(n.else, out, scopeVar);
            out.push('}');
          }
          out.push('}');
          break;
        }
        case 'for': {
          const xs = `x${seq++}`;
          const len = `l${seq++}`;
          const j = `i${seq++}`;
          const sv = `s${seq++}`;
          const sc = `c${seq++}`;
          const key = JSON.stringify(n.name);
          out.push(`{const ${xs}=${pathExpr(n.path)};if(Array.isArray(${xs})){const ${len}=${xs}.length;`);
          out.push(`const ${sv}={${key}:undefined,loop:{index:0,first:false,last:false,length:0}};`);
          out.push(`const ${sc}={vars:${sv},parent:${scopeVar}};`);
          out.push(`for(let ${j}=0;${j}<${len};${j}++){${sv}[${key}]=${xs}[${j}];`);
          out.push(`const ${sv}l=${sv}.loop;${sv}l.index=${j}+1;${sv}l.first=${j}===0;${sv}l.last=${j}===${len}-1;${sv}l.length=${len};`);
          emit(n.body, out, sc);
          out.push('}}}');
          break;
        }
        case 'include': {
          const target = indexOf.get(n.name);
          if (target !== undefined) out.push(`if(depth<${INCLUDE_DEPTH})out+=TPL[${target}](${scopeVar},depth+1);`);
          break;
        }
      }
    }
  };

  for (let k = 0; k < order.length; k++) {
    const out = [];
    emit(parsed.get(order[k]), out, 'scope');
    bodies.push(`function(scope,depth){let out='';${out.join('')}return out;}`);
  }

  TPL_HELPERS.paths = paths;
  const src = `const LOOK1=H.LOOK1,LOOK2=H.LOOK2,LOOKN=H.LOOKN,TXT=H.TXT,TRU=H.TRU,ES=H.ES,P=H.paths;const TPL=[];${bodies
    .map((b, k) => `TPL[${k}]=${b};`)
    .join('')}return TPL;`;
  const factory = new Function('H', src);
  const fns = factory(TPL_HELPERS);
  const compiled = new Map();
  for (let k = 0; k < order.length; k++) compiled.set(order[k], fns[k]);
  return compiled;
}

// ---------------------------------------------------------------- paths & links

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  let k = parts.length;
  const n = rel.length;
  let i = 0;
  while (i <= n) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = n;
    const seg = i === j ? '' : rel.slice(i, j);
    if (seg !== '' && seg !== '.') {
      if (seg === '..') {
        if (k === 0) return null;
        k--;
      } else parts[k++] = seg;
    }
    i = j + 1;
  }
  if (k === parts.length) return parts.join('/');
  return parts.slice(0, k).join('/');
}

function hasScheme(target) {
  const n = target.length;
  if (n === 0) return false;
  let c = target.charCodeAt(0);
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
  for (let i = 1; i < n; i++) {
    c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45)) return false;
  }
  return false;
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];

export function run(input) {
  const slugMemo = new Map();
  const slugOf = (text) => {
    let v = slugMemo.get(text);
    if (v === undefined) { v = slugifyRaw(text); slugMemo.set(text, v); }
    return v;
  };
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. templates, parsed once, in code-unit order of their names
  const templates = new Map();
  const report = [];
  const parsedNames = [];
  const tnames = Object.keys(input.templates).sort();
  for (let k = 0; k < tnames.length; k++) {
    const name = tnames[k];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
      parsedNames.push(name);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const compiled = compileTemplates(templates, parsedNames);

  // 2. sources
  const files = input.files.slice().sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const allSources = [];
  const statics = [];
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    if (f.path.endsWith('.md')) allSources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 3. front matter, the refusals in their order
  const sources = [];
  for (let k = 0; k < allSources.length; k++) {
    const s = allSources[k];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    const isPost = s.path.startsWith('posts/');
    s.post = isPost;
    let own;
    if (!isPost) {
      if (s.path.startsWith('tags/')) own = 'tags';
      else if (s.path.startsWith('page/')) own = 'page';
    }
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (isPost && !hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (isPost ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    sources.push(s);
  }

  // 4. permalinks
  const taken = new Map();
  const bySource = new Map();
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 5. Markdown, links resolved
  const staticPaths = new Set();
  for (let k = 0; k < statics.length; k++) staticPaths.add(statics[k].path);
  const broken = new Set();
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const hit = bySource.get(path);
        if (hit !== undefined) return `${hit.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, { link, slug: slugOf });
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = countWords(s.body);
  }

  // 6. collections
  const posts = [];
  for (let k = 0; k < sources.length; k++) if (sources[k].post) posts.push(sources[k]);
  posts.sort((x, y) => {
    const a = x.data.date;
    const b = y.data.date;
    if (a !== b) return a < b ? 1 : -1;
    const p = x.slug;
    const q = y.slug;
    return p < q ? -1 : p > q ? 1 : 0;
  });
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 7. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const list = s.data.tags ?? [];
    const out = [];
    const seen = new Set();
    for (let k = 0; k < list.length; k++) {
      const name = list[k];
      const slug = slugOf(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    if (s.post) continue;
    const names = ownTags(s);
    s.tagRefs = [];
    for (let j = 0; j < names.length; j++) {
      const name = names[j];
      const slug = slugOf(name);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));

  // 8. cards and pages
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  for (let k = 0; k < posts.length; k++) cards.set(posts[k], cardOf(posts[k]));
  for (let k = 0; k < sources.length; k++) if (!sources[k].post) sources[k].card = cardOf(sources[k]);

  // 9. layouts
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: escapeHtml };
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    return fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0);
  };
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    const card = s.post ? cards.get(s) : s.card;
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let k = 0; k < tags.length; k++) {
    const t = tags[k];
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let k = 0; k < statics.length; k++) {
    const f = statics[k];
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 10. the report
  const lines = report.concat([...broken]).sort();
  let pageCount = 0;
  for (let k = 0; k < sources.length; k++) if (!sources[k].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
