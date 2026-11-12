'use strict';

const { EmptySlugError, InvalidLimitError } = require('./errors');

function slugify(title, limit = 60) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidLimitError('limit must be at least 1');
  }
  let slug = String(title)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') throw new EmptySlugError('title produces an empty slug');
  if (slug.length > limit) slug = slug.slice(0, limit).replace(/-+$/, '');
  return slug;
}

module.exports = { slugify };
