import { win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (win32.isAbsolute(specifier)) {
    return { shortCircuit: true, url: pathToFileURL(specifier).href };
  }
  if (specifier.endsWith('.js')) {
    try {
      return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    } catch {
      // Keep ordinary JavaScript package imports on the default resolver.
    }
  }
  return nextResolve(specifier, context);
}
