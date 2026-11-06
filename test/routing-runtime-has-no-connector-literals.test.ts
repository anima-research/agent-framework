/** B's new runtime must be connector-neutral; existing modules are covered behaviorally. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

const introducedRuntime = ['src/mcpl/reply-routing.ts', 'src/mcpl/reply-admission.ts'];

const connectorVocabulary = /slack|telegram|discord|zulip|eidoverse|supportRecipientBridge|supportRecipientReplyRoot|supportRecipientTurnId/i;
const runtimeKinds = new Set(['Identifier', 'StringLiteral', 'RegExpLiteral', 'TemplateElement']);
const commentKeys = new Set(['comments', 'leadingComments', 'trailingComments', 'innerComments', 'loc']);

for (const file of introducedRuntime) test(`new routing runtime has no connector vocabulary: ${file}`, () => {
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (runtimeKinds.has(node.type)) {
      const value = String(node.name ?? node.value?.raw ?? node.value ?? node.pattern);
      if (connectorVocabulary.test(value)) {
        const key = `${node.type}:${value}`;
        assert.fail(`${file}:${node.loc.start.line}: connector policy: ${key}`);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (commentKeys.has(key)) continue;
      if (Array.isArray(value)) value.forEach(visit); else visit(value);
    }
  };
  visit(parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript'] }));
});
