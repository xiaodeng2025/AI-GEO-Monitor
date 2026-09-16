import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export function resolvePromptSetPath(fileName, promptDirectory = resolve('prompts')) {
  if (!fileName || isAbsolute(fileName)) throw new Error('Prompt file must be a relative path inside prompts/.');
  const candidate = resolve(promptDirectory, fileName);
  const relativePath = relative(promptDirectory, candidate);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Prompt file must stay inside prompts/.');
  }
  return candidate;
}

export async function loadPromptSet(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(parsed.prompts) || parsed.prompts.length === 0) {
    throw new Error('Prompt file must contain a non-empty prompts array.');
  }
  for (const prompt of parsed.prompts) {
    if (!prompt.id || !prompt.text) throw new Error('Each prompt needs id and text.');
  }
  return parsed;
}
