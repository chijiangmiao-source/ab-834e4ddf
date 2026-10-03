/* Web Worker：在后台线程解析输入并运行复核规则，避免阻塞页面。 */
importScripts('analyzer.js');

self.onmessage = function (e) {
  var data = e.data || {};
  try {
    var pi = Analyzer.parseInitial(data.initial);
    if (pi.error) { self.postMessage({ type: 'input-error', message: pi.error }); return; }
    var pe = Analyzer.parseEvents(data.events);
    if (pe.error) { self.postMessage({ type: 'input-error', message: pe.error }); return; }
    var result = Analyzer.verify(pi.nodes, pe.events);
    self.postMessage({ type: 'result', result: result });
  } catch (err) {
    self.postMessage({ type: 'failure', message: String((err && err.message) || err) });
  }
};
