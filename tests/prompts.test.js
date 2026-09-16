import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadPromptSet, resolvePromptSetPath } from '../src/core/prompts.js';

test('selects the isolated natural-monitoring final-acceptance prompt file', async () => {
  const path = resolvePromptSetPath('kimi-natural-final-acceptance.json', resolve('prompts'));
  const promptSet = await loadPromptSet(path);
  assert.equal(promptSet.prompt_set_classification, 'natural_monitoring');
  assert.deepEqual(promptSet.prompts, [{
    id: 'kimi-natural-final-acceptance',
    text: '今年中国新能源汽车出口情况怎么样？',
    purpose: '一次性自然用户最终人工验收'
  }]);
});

test('rejects prompt-file traversal outside the prompts directory', () => {
  assert.throws(
    () => resolvePromptSetPath('../outside.json', resolve('prompts')),
    /stay inside prompts/
  );
});
