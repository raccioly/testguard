/**
 * Tolerant JSON for tsconfig/jsconfig, which `tsc` reads as JSONC: comments,
 * trailing commas and a byte order mark are legal there (#330). One string-aware
 * scanner serves every reader, so a "src/**\/*.ts" glob or a URL inside a string
 * is never taken for a comment.
 *
 * Comments become spaces and a trailing comma becomes a space, so the text that
 * reaches JSON.parse keeps its offsets and genuinely invalid JSON fails with
 * the usual JSON.parse message. Nothing else is relaxed: single quotes, bare
 * keys and an unterminated block comment are still errors.
 */
export function parseJsonc(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let out = '';
  let i = 0;
  let pendingComma = -1; // index in `out` of a comma not yet followed by a value
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      pendingComma = -1;
      i = j + 1;
    } else if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j++;
      out += ' '.repeat(j - i);
      i = j;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new SyntaxError('Unterminated comment in JSON');
      out += src.slice(i, end + 2).replace(/[^\n\r]/g, ' ');
      i = end + 2;
    } else if (c === ',') {
      pendingComma = out.length;
      out += c;
      i++;
    } else if ((c === '}' || c === ']') && pendingComma !== -1) {
      out = `${out.slice(0, pendingComma)} ${out.slice(pendingComma + 1)}${c}`;
      pendingComma = -1;
      i++;
    } else {
      if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') pendingComma = -1;
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}
