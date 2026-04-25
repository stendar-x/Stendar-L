export function safeReadEnv(key: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) {
    return undefined;
  }
  const value = process.env[key];
  return typeof value === 'string' ? value : undefined;
}
