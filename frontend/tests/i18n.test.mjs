import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
const root = fileURLToPath(new URL('../src/', import.meta.url));
const codes = ['vi', 'en', 'fr', 'ko', 'ja', 'es'];
const dictionaries = Object.fromEntries(codes.map(code => [code, JSON.parse(readFileSync(`${root}lib/i18n/${code}.json`, 'utf8'))]));
const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
for (const code of codes) test(`${code}: complete dictionary and interpolation parameters`, () => {
  assert.deepEqual(Object.keys(dictionaries[code]).sort(), Object.keys(dictionaries.vi).sort());
  for (const [key, value] of Object.entries(dictionaries[code])) {
    assert.ok(value.trim(), `${code}: empty ${key}`);
    assert.deepEqual(placeholders(value), placeholders(dictionaries.vi[key]), `${code}: ${key}`);
  }
});
test('every literal translation used by the interface exists', () => {
  function visitDirectory(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visitDirectory(path);
      else if (path.endsWith('.tsx')) {
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        function visit(node) {
          if (ts.isCallExpression(node) && node.expression.getText(source) === 'tx' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
            assert.ok(Object.hasOwn(dictionaries.vi, node.arguments[0].text), `${path}: missing ${node.arguments[0].text}`);
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  visitDirectory(root);
});
