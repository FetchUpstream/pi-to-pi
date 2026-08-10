import { win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

function normalizeSpecifier(specifier) {
  return win32.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
}

export async function resolve(specifier, context, nextResolve) {
  const normalizedSpecifier = normalizeSpecifier(specifier);
  if (normalizedSpecifier.endsWith('.js')) {
    try {
      return await nextResolve(`${normalizedSpecifier.slice(0, -3)}.ts`, context);
    } catch {
      // Keep ordinary JavaScript package imports on the default resolver.
    }
  }
  return nextResolve(normalizedSpecifier, context);
}
