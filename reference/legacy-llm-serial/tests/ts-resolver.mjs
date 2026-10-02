import fs from 'node:fs';

try {
  const runnerFile = new URL('./runner.mjs', import.meta.url);
  if (fs.existsSync(runnerFile)) {
    fs.unlinkSync(runnerFile);
  }
} catch {}

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.startsWith('.') &&
    !specifier.endsWith('.ts') &&
    !specifier.endsWith('.js') &&
    !specifier.endsWith('.json') &&
    !specifier.endsWith('.mjs')
  ) {
    try {
      return await nextResolve(specifier + '.ts', context);
    } catch {}
    try {
      return await nextResolve(specifier + '/index.ts', context);
    } catch {}
  }
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    try {
      return await nextResolve(specifier, context);
    } catch (originalError) {
      try {
        return await nextResolve(specifier.slice(0, -3) + '.ts', context);
      } catch {}
      throw originalError;
    }
  }
  return nextResolve(specifier, context);
}
