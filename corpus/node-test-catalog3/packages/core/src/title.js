import { InvalidTitleError } from './errors.js';

export function normalizeTitle(input) {
  const title = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
  if (title === '') throw new InvalidTitleError('Title must not be empty');
  return title;
}
