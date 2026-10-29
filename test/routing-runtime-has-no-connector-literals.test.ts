/**
 * Connector policy stays outside the new admission runtime. These are the
 * existing upstream compatibility sites, inventoried by file, AST kind/value
 * and occurrence ceiling. Removing an old site is allowed; new vocabulary or
 * another occurrence is not. Comments are not runtime policy. This test needs
 * neither git history nor a generated baseline at test time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

const inherited: Record<string, Record<string, number>> = {
  "src/framework.ts": {
    "Identifier:announceDiscordAwarenessImport": 2,
    "Identifier:announceDiscordAwarenessRecovery": 2,
    "Identifier:boundDiscordAwarenessText": 5,
    "Identifier:byDiscordId": 3,
    "Identifier:cancelDiscordAwareness": 2,
    "Identifier:checkedDiscordAwarenessMarks": 4,
    "Identifier:DEFAULT_DISCORD_AWARENESS_DEADLINE_MS": 3,
    "Identifier:DEFAULT_DISCORD_AWARENESS_EMOJI": 5,
    "Identifier:defaultDiscordAwarenessOutboxPath": 3,
    "Identifier:deliverDiscordAwarenessInBackground": 9,
    "Identifier:DISCORD_SUPPRESSED_REACTIONS_BASELINE": 2,
    "Identifier:DiscordAwarenessAccountingError": 8,
    "Identifier:DiscordAwarenessBatch": 5,
    "Identifier:DiscordAwarenessCancelReceipt": 4,
    "Identifier:discordAwarenessDeadlineMs": 6,
    "Identifier:DiscordAwarenessDrainOutcome": 5,
    "Identifier:DiscordAwarenessDrainPass": 3,
    "Identifier:discordAwarenessDrains": 7,
    "Identifier:discordAwarenessDrainsJoined": 4,
    "Identifier:discordAwarenessEmoji": 9,
    "Identifier:DiscordAwarenessImportedUnsent": 3,
    "Identifier:DiscordAwarenessMarks": 7,
    "Identifier:discordAwarenessOutbox": 25,
    "Identifier:DiscordAwarenessOutbox": 7,
    "Identifier:discordAwarenessOutboxPath": 6,
    "Identifier:DiscordAwarenessPrepareInput": 3,
    "Identifier:DiscordAwarenessRefusal": 4,
    "Identifier:DiscordAwarenessRequest": 5,
    "Identifier:DiscordAwarenessRetirement": 4,
    "Identifier:DiscordAwarenessRetractReceipt": 4,
    "Identifier:DiscordAwarenessScope": 5,
    "Identifier:DiscordAwarenessSettlement": 3,
    "Identifier:DiscordAwarenessView": 4,
    "Identifier:discordChannelOf": 3,
    "Identifier:discordIdOf": 3,
    "Identifier:discordRefs": 2,
    "Identifier:discordSendFailed": 4,
    "Identifier:drainDiscordAwarenessOutbox": 2,
    "Identifier:extractDiscordAwarenessRefs": 5,
    "Identifier:isPermanentDiscordReactionFailure": 4,
    "Identifier:listDiscordAwareness": 2,
    "Identifier:MAX_DISCORD_AWARENESS_DEADLINE_MS": 2,
    "Identifier:MIN_DISCORD_AWARENESS_DEADLINE_MS": 2,
    "Identifier:normalizeDiscordAwarenessDeadline": 2,
    "Identifier:readDiscordAwarenessDue": 4,
    "Identifier:reconcileDiscordAwarenessAtStartup": 2,
    "Identifier:resumePreparedDiscordSuppressions": 2,
    "Identifier:retractDiscordAwareness": 2,
    "Identifier:runDiscordAwarenessDrain": 2,
    "Identifier:runDiscordAwarenessSync": 3,
    "Identifier:selectDiscordAwarenessRefs": 5,
    "Identifier:syncDiscordAwarenessMarkers": 1,
    "StringLiteral:./recovery/discord-awareness-outbox.js": 1,
    "StringLiteral:Channel id, glob ok (e.g. \"discord:*:12345\").": 1,
    "StringLiteral:discord": 2,
    "StringLiteral:DISCORD_SUPPRESSED_REACTIONS_BASELINE": 1,
    "StringLiteral:discord-awareness-delivery": 3,
    "StringLiteral:discord-awareness-import-unsent": 1,
    "StringLiteral:discord-awareness-not-scheduled": 2,
    "StringLiteral:discord-awareness-unresolved": 1,
    "StringLiteral:discord-send-failed": 5,
    "StringLiteral:DiscordAwarenessAccountingError": 1,
    "StringLiteral:discordAwarenessOutboxPath": 1,
    "StringLiteral:discordAwarenessOutboxPath), so it holds no marks": 1,
    "StringLiteral:e.g. `{ name: \"watch-cairn\", match: { source: \"discord\", channel: \"discord:*:12345\", tagsAny: [\"chat:ambient\"] }, debounceMs: 60000 }` ": 1,
    "StringLiteral:Integration/serverId, glob ok (e.g. \"discord\").": 1,
    "StringLiteral:that prose to one uniquely resolved authorized Discord or Eidoverse channel. The ": 1,
    "StringLiteral:The safe way to order against a specific catch-all, e.g. insertBefore: \"discord-ambient\".": 1,
    "TemplateElement:: Discord refused them for good, ": 1,
    "TemplateElement:: DISCORD_SUPPRESSED_REACTIONS_BASELINE ": 1,
    "TemplateElement:[discord-awareness] ": 9,
    "TemplateElement:[discord-awareness] agent=": 1,
    "TemplateElement:[discord-awareness] delivery after ": 2,
    "TemplateElement:[discord-awareness] startup: retiring ": 1,
    "TemplateElement:[discord-awareness] this start retires version 2 awareness batch ": 1,
    "TemplateElement:Cannot resume Discord suppression ": 1,
    "TemplateElement:Cannot safely resume Discord suppression ": 1,
    "TemplateElement:Discord ": 1,
    "TemplateElement:Discord awareness accounting failed during ": 1,
    "TemplateElement:discord:": 1
  },
  "src/index.ts": {
    "Identifier:DEFAULT_DISCORD_AWARENESS_EMOJI": 2,
    "Identifier:defaultDiscordAwarenessOutboxPath": 2,
    "Identifier:DiscordAwarenessAction": 2,
    "Identifier:DiscordAwarenessBatch": 2,
    "Identifier:DiscordAwarenessBatchStatus": 2,
    "Identifier:DiscordAwarenessBatchView": 2,
    "Identifier:DiscordAwarenessCancelReceipt": 2,
    "Identifier:DiscordAwarenessImportedUnsent": 2,
    "Identifier:DiscordAwarenessMarks": 2,
    "Identifier:DiscordAwarenessOutbox": 2,
    "Identifier:DiscordAwarenessOutcome": 2,
    "Identifier:DiscordAwarenessPrepareInput": 2,
    "Identifier:DiscordAwarenessReactionState": 2,
    "Identifier:DiscordAwarenessRef": 2,
    "Identifier:DiscordAwarenessRefusal": 2,
    "Identifier:DiscordAwarenessRequest": 2,
    "Identifier:DiscordAwarenessRetirement": 2,
    "Identifier:DiscordAwarenessRetractReceipt": 2,
    "Identifier:DiscordAwarenessRetractView": 2,
    "Identifier:DiscordAwarenessScope": 2,
    "Identifier:DiscordAwarenessSettlement": 2,
    "Identifier:DiscordAwarenessView": 2,
    "Identifier:DiscordSuppressionInterval": 2,
    "Identifier:extractDiscordAwarenessRefs": 2,
    "Identifier:isPermanentDiscordReactionFailure": 2,
    "Identifier:selectDiscordAwarenessRefs": 2,
    "StringLiteral:./recovery/discord-awareness-outbox.js": 2
  },
  "src/mcpl/channel-registry.ts": {},
  "src/mcpl/inbound-admission.ts": {},
  "src/mcpl/inference-router.ts": {},
  "src/mcpl/protocol-family.ts": {},
  "src/mcpl/push-handler.ts": {},
  "src/mcpl/server-connection.ts": {},
  "src/mcpl/types.ts": {}
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
