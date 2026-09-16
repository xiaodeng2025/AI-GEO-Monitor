import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BrowserRuntime } from './core/browser-runtime.js';
import { yuanbaoRuntimeConfig } from './platforms/yuanbao/yuanbao-runtime-config.js';

const prompt = '今年中国新能源汽车出口情况怎么样？';
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = resolve('artifacts', 'yuanbao-natural-run', runStamp);
const runtime = new BrowserRuntime({
  profileDir: resolve('profiles', 'yuanbao'),
  headless: false,
  ...yuanbaoRuntimeConfig
});

const actionSelector = 'button, [role="button"]';
const responseSelector = '.agent-chat__conv--ai';
const editorSelector = '.ql-editor[contenteditable="true"]';

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function writeJson(name, value) {
  await writeFile(resolve(runDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function describeVisibleActions(page) {
  const actions = await page.locator(actionSelector).evaluateAll((elements) => elements.map((element, index) => ({
    index,
    text: (element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    ariaLabel: element.getAttribute('aria-label'),
    title: element.getAttribute('title'),
    disabled: element.hasAttribute('disabled'),
    visible: Boolean(element.getClientRects().length)
  })));
  return actions.filter((entry) => entry.visible);
}

async function findAction(page, names, { exact = false } = {}) {
  const actions = await describeVisibleActions(page);
  return actions.find((action) => {
    const labels = [action.text, action.ariaLabel, action.title].filter(Boolean);
    return names.some((name) => labels.some((label) => exact ? label === name : label === name || label.includes(name)));
  }) ?? null;
}

async function findNewChat(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const describe = (element) => ({
      tag: element.tagName.toLowerCase(),
      classNames: [...element.classList],
      attributes: Object.fromEntries([...element.attributes]
        .filter((attribute) => ['role', 'aria-label', 'title', 'aria-current', 'aria-selected'].includes(attribute.name) || attribute.name.startsWith('data-'))
        .map((attribute) => [attribute.name, attribute.name.startsWith('data-') ? true : attribute.value]))
    });
    const candidate = [...document.querySelectorAll('*')].find((element) => {
      if (!element.getClientRects().length || normalize(element.innerText) !== '新对话') return false;
      return ![...element.children].some((child) => normalize(child.innerText) === '新对话');
    });
    if (!candidate) return null;
    const target = candidate.closest('button, [role="button"], a, [onclick]') || candidate;
    const ancestors = [];
    let current = candidate.parentElement;
    while (current && ancestors.length < 4) {
      ancestors.push(describe(current));
      current = current.parentElement;
    }
    return { candidate: describe(candidate), target: describe(target), ancestors };
  });
}

async function clickNewChat(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const candidate = [...document.querySelectorAll('*')].find((element) => {
      if (!element.getClientRects().length || normalize(element.innerText) !== '新对话') return false;
      return ![...element.children].some((child) => normalize(child.innerText) === '新对话');
    });
    if (!candidate) return false;
    (candidate.closest('button, [role="button"], a, [onclick]') || candidate).click();
    return true;
  });
}

async function findComposerSendControl(editor) {
  return editor.evaluate((editorElement) => {
    const visible = (element) => Boolean(element.getClientRects().length);
    const describe = (element) => ({
      tag: element.tagName.toLowerCase(),
      classNames: [...element.classList],
      attributes: Object.fromEntries([...element.attributes]
        .filter((attribute) => ['role', 'aria-label', 'title', 'aria-disabled', 'disabled'].includes(attribute.name) || attribute.name.startsWith('data-'))
        .map((attribute) => [attribute.name, attribute.name.startsWith('data-') ? true : attribute.value])),
      text: String(element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    });
    let composer = editorElement.parentElement;
    for (let depth = 0; composer && depth < 10; depth += 1, composer = composer.parentElement) {
      const candidates = [...composer.querySelectorAll('[aria-label="发送"], [title="发送"], [class*="send" i]')]
        .map((element) => element.closest('button, [role="button"], [onclick], [tabindex]') || element)
        .filter((element, index, all) => visible(element) && all.indexOf(element) === index && element.getAttribute('aria-disabled') !== 'true' && !element.hasAttribute('disabled'));
      if (candidates.length) return { composer: describe(composer), candidates: candidates.map(describe) };
    }
    return { composer: null, candidates: [] };
  });
}

async function clickComposerSendControl(editor) {
  return editor.evaluate((editorElement) => {
    const visible = (element) => Boolean(element.getClientRects().length);
    let composer = editorElement.parentElement;
    for (let depth = 0; composer && depth < 10; depth += 1, composer = composer.parentElement) {
      const candidates = [...composer.querySelectorAll('[aria-label="发送"], [title="发送"], [class*="send" i]')]
        .map((element) => element.closest('button, [role="button"], [onclick], [tabindex]') || element)
        .filter((element, index, all) => visible(element) && all.indexOf(element) === index && element.getAttribute('aria-disabled') !== 'true' && !element.hasAttribute('disabled'));
      if (candidates.length === 1) {
        candidates[0].click();
        return true;
      }
      if (candidates.length > 1) return false;
    }
    return false;
  });
}

async function describeEditorNeighborhood(editor) {
  return editor.evaluate((editorElement) => {
    const describe = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        classNames: [...element.classList],
        attributes: Object.fromEntries([...element.attributes]
          .filter((attribute) => ['role', 'aria-label', 'title', 'aria-disabled', 'disabled', 'tabindex'].includes(attribute.name) || attribute.name.startsWith('data-'))
          .map((attribute) => [attribute.name, attribute.name.startsWith('data-') ? true : attribute.value])),
        visible: Boolean(element.getClientRects().length),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      };
    };
    const levels = [];
    let current = editorElement;
    while (current && levels.length < 10) {
      levels.push({ element: describe(current), children: [...current.children].slice(0, 50).map(describe) });
      current = current.parentElement;
    }
    return levels;
  });
}

async function assistantCount(page) {
  return page.locator(responseSelector).count();
}

async function responseSnapshot(page, baselineCount) {
  return page.locator(responseSelector).evaluateAll((elements, baseline) => elements.slice(baseline).map((element, index) => ({
    index: baseline + index,
    visible: Boolean(element.getClientRects().length),
    textLength: (element.innerText || '').trim().length,
    classNames: [...element.classList],
    dataAttributes: Object.fromEntries([...element.attributes]
      .filter((attribute) => attribute.name.startsWith('data-'))
      .map((attribute) => [attribute.name, true]))
  })), baselineCount);
}

async function stopVisible(page) {
  const actions = await describeVisibleActions(page);
  return actions.some((action) => /停止|stop/i.test([action.text, action.ariaLabel, action.title].filter(Boolean).join(' ')));
}

async function captureLocator(locator, htmlName, imageName) {
  await writeFile(resolve(runDir, htmlName), await locator.evaluate((element) => element.outerHTML), 'utf8');
  await locator.screenshot({ path: resolve(runDir, imageName) });
}

async function captureResponseEvidence(page, baselineCount) {
  const response = page.locator(responseSelector).nth(baselineCount);
  await captureLocator(response, 'response-root.html', 'response-root.png');
  const structure = await response.evaluate((root) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const attributes = (element) => Object.fromEntries([...element.attributes]
      .filter((attribute) => ['role', 'aria-label', 'title'].includes(attribute.name) || attribute.name.startsWith('data-'))
      .map((attribute) => [attribute.name, attribute.name.startsWith('data-') ? true : attribute.value]));
    const containedCitations = [...root.querySelectorAll('a[href]')].map((link, index) => {
      let domain = null;
      try { domain = new URL(link.href).hostname; } catch {}
      return { position: index + 1, href: link.href, domain, text: normalize(link.innerText), attributes: attributes(link) };
    });
    const sourceControls = [...root.querySelectorAll('[aria-label*="引用"], [aria-label*="来源"], [data-source], [data-citation], [data-reference], [class*="citation" i], [class*="reference" i], [class*="cite" i]')]
      .filter((element) => Boolean(element.getClientRects().length))
      .map((element) => ({ tag: element.tagName.toLowerCase(), classNames: [...element.classList], attributes: attributes(element) }));
    const stages = [...root.querySelectorAll('[class]')]
      .filter((element) => /thinking|search|tool|markdown|answer/i.test(element.className) && Boolean(element.getClientRects().length))
      .slice(0, 50)
      .map((element) => ({ tag: element.tagName.toLowerCase(), classNames: [...element.classList], textLength: normalize(element.innerText).length }));
    return { containedCitations, sourceControls, stages };
  });
  await writeJson('response-structure.json', structure);
}

async function capturePopupEvidence(page) {
  const popups = page.locator('[role="tooltip"], [role="dialog"], [data-popper-placement], [data-state="open"], [data-floating-ui-portal]');
  const count = await popups.count();
  const evidence = [];
  for (let index = 0; index < count; index += 1) {
    const popup = popups.nth(index);
    if (!await popup.isVisible()) continue;
    evidence.push(await popup.evaluate((element) => {
      const text = String(element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const sources = [...element.querySelectorAll('a[href]')].map((link, position) => {
        let domain = null;
        try { domain = new URL(link.href).hostname; } catch {}
        return {
          position: position + 1,
          href: link.href,
          domain,
          text: String(link.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500),
          title: link.getAttribute('title'),
          siteName: link.getAttribute('data-site-name')
        };
      });
      return { classNames: [...element.classList], text, sources };
    }));
  }
  await writeJson('visible-popups.json', evidence);
}

async function waitForCompletion(page, baselineCount) {
  const timeline = [];
  let stablePolls = 0;
  let previousTextLength = -1;
  for (let poll = 0; poll < 180; poll += 1) {
    const responses = await responseSnapshot(page, baselineCount);
    const latest = responses.at(-1) ?? null;
    const generating = await stopVisible(page);
    timeline.push({ elapsedSeconds: poll, responseCount: responses.length, latest, generating });
    if (latest?.visible && latest.textLength > 0 && !generating && latest.textLength === previousTextLength) {
      stablePolls += 1;
      if (stablePolls >= 3) {
        await writeJson('generation-timeline.json', timeline);
        return { status: 'completed', timeline };
      }
    } else {
      stablePolls = 0;
    }
    previousTextLength = latest?.textLength ?? -1;
    await page.waitForTimeout(1000);
  }
  await writeJson('generation-timeline.json', timeline);
  return { status: 'timeout', timeline };
}

try {
  await mkdir(runDir, { recursive: true });
  const page = await runtime.newPage();
  await page.goto('https://yuanbao.tencent.com/', { waitUntil: 'domcontentloaded' });
  const before = {
    path: await page.evaluate(() => location.pathname),
    actions: await describeVisibleActions(page),
    newChat: await findNewChat(page),
    assistantCount: await assistantCount(page)
  };
  await writeJson('fresh-chat-before.json', before);

  if (!before.newChat) {
    await writeJson('run-status.json', { status: 'blocked_fresh_chat', reason: 'No visible exact-text new-chat element was found.', before });
    console.log(`Fresh chat could not be confirmed. No Prompt was submitted. Evidence: ${runDir}`);
    await new Promise((resolveStop) => process.once('SIGINT', resolveStop));
    process.exitCode = 2;
  } else {
    await clickNewChat(page);
    await page.waitForTimeout(1000);
    const baselineCount = await assistantCount(page);
    const editor = page.locator(editorSelector).first();
    const fresh = {
      newChat: before.newChat,
      path: await page.evaluate(() => location.pathname),
      assistantCount: baselineCount,
      editorVisible: await editor.isVisible(),
      editorText: cleanText(await editor.innerText())
    };
    await writeJson('fresh-chat-confirmation.json', fresh);
    if (baselineCount !== 0 || !fresh.editorVisible || fresh.editorText) {
      await writeJson('run-status.json', { status: 'blocked_fresh_chat', reason: 'New-chat action did not yield an empty assistant baseline with a blank visible editor.', fresh });
      console.log(`Fresh chat could not be confirmed. No Prompt was submitted. Evidence: ${runDir}`);
      await new Promise((resolveStop) => process.once('SIGINT', resolveStop));
      process.exitCode = 2;
    } else {
      await captureLocator(editor, 'prompt-editor-before.html', 'prompt-editor-before.png');
      await editor.click();
      await page.keyboard.insertText(prompt);
      const enteredText = cleanText(await editor.innerText());
      await writeJson('prompt-editor-after-input.json', { enteredText, expectedText: prompt, matches: enteredText === prompt });
      if (enteredText !== prompt) {
        await writeJson('run-status.json', { status: 'blocked_input', reason: 'Editor did not expose the exact approved Prompt after keyboard input.', fresh, enteredText });
        console.log(`Prompt editor input could not be confirmed. No Prompt was submitted. Evidence: ${runDir}`);
        await new Promise((resolveStop) => process.once('SIGINT', resolveStop));
        process.exitCode = 2;
      } else {
      const namedSendAction = await findAction(page, ['发送'], { exact: true });
      const composerSend = namedSendAction ? null : await findComposerSendControl(editor);
      const canSubmit = namedSendAction && !namedSendAction.disabled || composerSend?.candidates.length === 1;
      await writeJson('send-control.json', { namedSendAction, composerSend });
      if (!canSubmit) {
        await writeJson('editor-neighborhood.json', await describeEditorNeighborhood(editor));
        await writeJson('run-status.json', { status: 'blocked_send', reason: 'No unique enabled visible send control was found after filling the editor.', fresh, actions: await describeVisibleActions(page), composerSend });
        console.log(`Send control could not be confirmed. No Prompt was submitted. Evidence: ${runDir}`);
        await new Promise((resolveStop) => process.once('SIGINT', resolveStop));
        process.exitCode = 2;
      } else {
        if (namedSendAction) {
          await page.locator(actionSelector).nth(namedSendAction.index).click();
        } else if (!await clickComposerSendControl(editor)) {
          throw new Error('The uniquely identified composer send control could not be clicked.');
        }
        await writeJson('submission.json', { prompt, submittedAt: new Date().toISOString(), fresh, sendAction: namedSendAction ?? composerSend.candidates[0] });
        const completion = await waitForCompletion(page, baselineCount);
        if (completion.status === 'completed') {
          await captureResponseEvidence(page, baselineCount);
          await capturePopupEvidence(page);
        }
        await writeJson('run-status.json', { status: completion.status, prompt, fresh, completedAt: new Date().toISOString() });
        console.log(`Yuanbao natural Prompt finished with status=${completion.status}. Evidence: ${runDir}. Browser remains open for manual Citation inspection; press Ctrl+C here to close it.`);
        const popupInterval = setInterval(() => { capturePopupEvidence(page).catch(() => {}); }, 2000);
        await new Promise((resolveStop) => process.once('SIGINT', resolveStop));
        clearInterval(popupInterval);
      }
      }
    }
  }
} finally {
  await runtime.close();
}
