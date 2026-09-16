import { createHash, randomUUID } from 'node:crypto';

export function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}
