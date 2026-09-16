function payload(kind, fileName, content) {
  return { kind, fileName, content };
}

/** Materializes Playwright handles before the session is allowed to close. */
export class PlaywrightEvidenceProvider {
  async materializeAnswer({ handle, text, fingerprint }) {
    const html = await handle.evaluate((element) => element.outerHTML);
    return { answer: { text, html, fingerprint }, artifacts: [payload('answer_html', 'answer.html', html)] };
  }

  async materializeCitationEvidence(request = null) {
    if (!request) return [];
    const artifacts = [];
    let html = request.html;
    if (typeof html !== 'string' && request.handle && typeof request.handle.evaluate === 'function') {
      try {
        html = await request.handle.evaluate((element) => element.outerHTML);
      } catch (_error) {
        html = null;
      }
    }
    if (typeof html === 'string' && html) {
      artifacts.push(payload('citations_html', 'citations.html', html));
    }
    return artifacts;
  }

  /**
   * Supplementary visual context only: preserve the real page viewport after
   * completion, with the accepted final answer's tail in the lower-middle area.
   */
  async materializeTerminalContext({ page, answerHandle }) {
    if (!page || !answerHandle) return [];
    try {
      await page.keyboard?.press?.('Escape');
      await answerHandle.evaluate((element) => {
        let container = element.parentElement;
        while (container) {
          const style = getComputedStyle(container);
          if (/(auto|scroll)/.test(style.overflowY) && container.scrollHeight > container.clientHeight) break;
          container = container.parentElement;
        }
        const answerRect = element.getBoundingClientRect();
        if (container) {
          const containerRect = container.getBoundingClientRect();
          container.scrollTop += answerRect.bottom - (containerRect.top + container.clientHeight * 0.68);
          return;
        }
        window.scrollBy(0, answerRect.bottom - window.innerHeight * 0.68);
      });
      await page.waitForTimeout?.(500);
      return [payload('terminal_context_screenshot', 'terminal-context.png', await page.screenshot({ fullPage: false }))];
    } catch (_error) {
      // Context screenshot is supplementary and must not change semantic success.
      return [];
    }
  }

  async materializeCitationReplayDiagnostics(diagnostics) {
    if (!diagnostics || typeof diagnostics !== 'object') return [];
    return [payload(
      'citation_replay_diagnostics',
      'citation-replay-diagnostics.json',
      `${JSON.stringify(diagnostics, null, 2)}\n`
    )];
  }

  async materializeFailure({ page } = {}) {
    if (!page || typeof page.screenshot !== 'function') return [];
    try {
      return [payload('error_screenshot', 'error.png', await page.screenshot({ fullPage: false }))];
    } catch (_error) {
      return [];
    }
  }
}
