import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

async function sourceFacts(page) {
  return page.evaluate(() => {
    const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (node) => Boolean(node?.getClientRects?.().length);
    const text = cleanText(document.body?.innerText);
    const rows = [...document.querySelectorAll('ol li, ul li, [data-source], [data-reference]')]
      .filter(visible).map((node) => cleanText(node.innerText)).filter(Boolean);
    const evidence = /全球搜|搜索全球|引用网站|引用来源|来源网站/.test(text);
    return { evidence, sourceRowCount: rows.length, sourceTextLength: rows.join(' ').length, bodyLength: text.length };
  });
}

export async function collapseWenxinSidebar({ page }) {
  const native = page.locator('[aria-label*="收起"], [aria-label*="折叠"], [title*="收起"], [title*="折叠"]').first();
  const controls = page.locator('button, [role="button"]');
  const candidate = (await native.isVisible().catch(() => false))
    ? native
    : controls.filter({ hasText: /收起侧栏|折叠侧栏|collapse.*sidebar|sidebar.*collapse/i }).first();
  if (!(await candidate.isVisible().catch(() => false))) return { status: 'not_found' };
  await candidate.click();
  await page.waitForTimeout(500);
  return { status: 'collapsed' };
}

export async function expandWenxinSources({ page, settleMs = 500, maxAttempts = 20 }) {
  const trigger = page.locator('text=/全球搜|搜索全球|引用网站|引用来源|来源网站|检索\\s*\\d+\\s*篇资料/').last();
  await trigger.waitFor({ state: 'visible', timeout: 5_000 });
  const before = await sourceFacts(page);
  await trigger.click();
  let previous = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const facts = await sourceFacts(page);
    if (facts.evidence && facts.sourceTextLength > 0 && JSON.stringify(facts) === JSON.stringify(previous)) {
      return { status: 'expanded', before, facts };
    }
    previous = facts;
    await page.waitForTimeout(settleMs);
  }
  throw new Error('Wenxin source websites did not become stable after the native trigger click.');
}

export async function captureWenxinMhtml(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const result = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
    if (!result?.data) throw new Error('CDP Page.captureSnapshot returned no MHTML data.');
    return result.data;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export async function captureWenxinSnapshot({
  page,
  artifactDir,
  fileName = 'wenxin-snapshot.mhtml',
  captureMhtml = captureWenxinMhtml
}) {
  if (!page) throw new Error('captureWenxinSnapshot requires a completed Wenxin page.');
  if (!artifactDir) throw new Error('captureWenxinSnapshot requires artifactDir.');
  let sidebar;
  let sources;
  try {
    sidebar = await collapseWenxinSidebar({ page });
    sources = await expandWenxinSources({ page });
    const mhtml = await captureMhtml(page);
    await mkdir(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, fileName);
    await writeFile(artifactPath, mhtml, 'utf8');
    return {
      status: 'captured',
      preparation: { sidebar, sources },
      artifact: { kind: 'wenxin_snapshot_mhtml', fileName, path: artifactPath, bytes: (await stat(artifactPath)).size },
      domModified: false,
      interactionFrozen: false
    };
  } catch (error) {
    return {
      status: 'capture_failed',
      error: error instanceof Error ? error.message : String(error),
      preparation: { sidebar: sidebar || null, sources: sources || null },
      artifacts: [],
      domModified: false,
      interactionFrozen: false
    };
  }
}
