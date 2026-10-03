// analyze.worker.js — 在 Web Worker 中运行解析与规则判定，避免阻塞页面
import { analyze, parseInput } from '/src/engine.js';

self.onmessage = (e) => {
  const started = Date.now();
  try {
    const parsed = parseInput(e.data || {});
    if (!parsed.ok) {
      self.postMessage({ ok: false, stage: 'parse', errors: parsed.errors });
      return;
    }
    const result = analyze({ nodes: parsed.nodes, events: parsed.events });
    self.postMessage({ ok: true, stage: 'analysis', elapsedMs: Date.now() - started, ...result });
  } catch (err) {
    self.postMessage({
      ok: false,
      stage: 'fatal',
      errors: [String((err && err.stack) || err)]
    });
  }
};
