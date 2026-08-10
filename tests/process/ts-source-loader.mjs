import { pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  const normalizedSpecifier = /^[A-Za-z]:[\\/]/u.test(specifier)
    ? pathToFileURL(specifier).href
    : specifier;
  if (normalizedSpecifier.endsWith('.js')) {
    try {
      return await nextResolve(`${normalizedSpecifier.slice(0, -3)}.ts`, context);
    } catch {
      // Keep ordinary JavaScript package imports on the default resolver.
    }
  }
  return nextResolve(normalizedSpecifier, context);
}
