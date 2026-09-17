import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const hashFile = (path) => sha256(readFileSync(path));
