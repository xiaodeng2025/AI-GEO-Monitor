import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMentions } from '../src/analysis/mentions.js';

test('detectMentions returns deterministic brand and competitor matches', () => {
  const result = detectMentions('Example Brand 优于竞品甲，但 Competitor A 也可选。', {
    brand: { name: '示例品牌', aliases: ['Example Brand'] },
    competitors: [{ name: '竞品甲', aliases: ['Competitor A'] }]
  });
  assert.equal(result.brand_mentioned, true);
  assert.deepEqual(result.brand_hits, ['Example Brand']);
  assert.deepEqual(result.competitor_mentions, [{ name: '竞品甲', hits: ['竞品甲', 'Competitor A'] }]);
});
