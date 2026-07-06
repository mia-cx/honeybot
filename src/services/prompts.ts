import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ClassifierPrompt = 'scam-text' | 'scam-image';

export async function loadClassifierPrompt(prompt: ClassifierPrompt) {
  return readFile(join(process.cwd(), 'prompts', `${prompt}.md`), 'utf8');
}
