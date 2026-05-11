import test from 'node:test';

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

export function useScopedEnv(name: string, value: string | undefined): void {
  let previous: string | undefined;

  test.beforeEach(() => {
    previous = process.env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  });

  test.afterEach(() => {
    restoreEnv(name, previous);
  });
}

export function withEnv<T>(name: string, value: string | undefined, callback: () => T): T {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    return callback();
  } finally {
    restoreEnv(name, previous);
  }
}
