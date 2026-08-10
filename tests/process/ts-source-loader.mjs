export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js')) {
    try {
      return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    } catch {
      // Keep ordinary JavaScript package imports on the default resolver.
    }
  }
  return nextResolve(specifier, context);
}
