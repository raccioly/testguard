'use strict';

const { MissingValueError, TemplateSyntaxError } = require('./errors');

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const NAME = /^\s*(\w+)\s*$/;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function render(template, values, options = {}) {
  const lenient = options.lenient === true || options.mode === 'lenient';
  const map = values || {};
  let out = '';
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{{', i);
    if (open === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    const raw = template[open + 2] === '{';
    const closer = raw ? '}}}' : '}}';
    const start = open + (raw ? 3 : 2);
    const end = template.indexOf(closer, start);
    if (end === -1) {
      throw new TemplateSyntaxError(`unclosed placeholder at position ${open}`);
    }
    const match = NAME.exec(template.slice(start, end));
    if (!match) {
      out += template.slice(open, open + 2);
      i = open + 2;
      continue;
    }
    const name = match[1];
    if (Object.prototype.hasOwnProperty.call(map, name)) {
      const value = String(map[name]);
      out += raw ? value : escapeHtml(value);
    } else if (!lenient) {
      throw new MissingValueError(`missing value: ${name}`);
    }
    i = end + closer.length;
  }
  return out;
}

module.exports = { render, escapeHtml };
