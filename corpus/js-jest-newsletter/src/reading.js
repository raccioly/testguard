'use strict';

const { InvalidCountError, UnknownReaderError } = require('./errors');

const RATES = { skimmer: 400, careful: 200 };

function countWords(text) {
  const trimmed = String(text).trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

function readingTime(count, readerClass) {
  if (!Number.isInteger(count) || count < 0) {
    throw new InvalidCountError('count must be a non-negative integer');
  }
  if (!Object.prototype.hasOwnProperty.call(RATES, readerClass)) {
    throw new UnknownReaderError(`unknown reader: ${readerClass}`);
  }
  if (count === 0) return 0;
  return Math.max(1, Math.ceil(count / RATES[readerClass]));
}

module.exports = { countWords, readingTime };
