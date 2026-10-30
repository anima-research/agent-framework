/** Admission's new runtime has no connector policy; unrelated modules are out of scope. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

const inherited: Record<string, Record<string, number>> = {
  'src/mcpl/inbound-admission.ts': {},
};

const connectorVocabulary = /slack|telegram|discord|zulip|eidoverse|supportRecipientBridge|supportRecipientReplyRoot|supportRecipientTurnId/i;
const runtimeKinds = new Set(['Identifier', 'StringLiteral', 'RegExpLiteral', 'TemplateElement']);
const commentKeys = new Set(['comments', 'leadingComments', 'trailingComments', 'innerComments', 'loc']);

for (const [file, allowed] of Object.entries(inherited)) test(`routing runtime has no new connector literals: ${file}`, () => {
  const counts = new Map<string, number>();
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (runtimeKinds.has(node.type)) {
      const value = String(node.name ?? node.value?.raw ?? node.value ?? node.pattern);
      if (connectorVocabulary.test(value)) {
        const key = `${node.type}:${value}`;
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        assert(count <= (allowed[key] ?? 0), `${file}:${node.loc.start.line}: new connector policy: ${key} (${count} > ${allowed[key] ?? 0})`);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (commentKeys.has(key)) continue;
      if (Array.isArray(value)) value.forEach(visit); else visit(value);
    }
  };
  visit(parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript'] }));
});
