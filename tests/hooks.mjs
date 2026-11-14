// Module hooks for the unit tests: compile the app's TypeScript and swap native modules for fakes.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const here = new URL('./', import.meta.url);
const mock = (name) => new URL(`mocks/${name}`, here).href;
const MAP = {
  'react-native-libsodium': 'cube-test:sodium',
  'react-native-keychain': mock('keychain.mjs'),
  'expo-file-system': mock('expo-file-system.mjs'),
  react: mock('react.mjs'),
};

export async function resolve(specifier, context, next) {
  if (MAP[specifier]) return { url: MAP[specifier], shortCircuit: true };
  if (/\/modules\/cube-native$/.test(specifier)) return { url: mock('cube-native.mjs'), shortCircuit: true };
  const parent = context.parentURL ?? '';
  if (specifier.startsWith('.') && /\.tsx?(\?.*)?$/.test(parent) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    for (const ext of ['.ts', '.tsx', '/index.ts']) {
      const url = new URL(specifier + ext, parent);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}

let sodiumSource;
async function sodiumModule() {
  if (!sodiumSource) {
    const s = (await import('libsodium-wrappers-sumo')).default;
    await s.ready;
    const names = Object.keys(s).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default');
    sodiumSource =
      `import s from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('libsodium-wrappers-sumo')).href)};\nawait s.ready;\n` +
      names.map((n) => `export const ${n} = s.${n};`).join('\n') +
      '\nexport default s;\n';
  }
  return sodiumSource;
}

export async function load(url, context, next) {
  if (url === 'cube-test:sodium') return { format: 'module', source: await sodiumModule(), shortCircuit: true };
  const clean = url.split('?')[0];
  if (/\.tsx?$/.test(clean) && clean.startsWith('file:')) {
    const src = readFileSync(fileURLToPath(clean), 'utf8');
    const out = ts.transpileModule(src, {
      fileName: fileURLToPath(clean),
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        verbatimModuleSyntax: false,
      },
    });
    return { format: 'module', source: out.outputText, shortCircuit: true };
  }
  return next(url, context);
}
