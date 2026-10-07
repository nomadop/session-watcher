// dsh/src/client/locales.js — the tab's label, state and badge texts, the state text and the signal state a result without a reading reads as, and the dock's texts under the plugin's locale namespace.

/** The locale namespace the tab registers and binds. */
export const NS = 'session-watcher';

/** A result without a reading as its `state.*` text: null is still bootstrapping, and a failed or unreachable result carries its message. */
export function stateText(result, t) {
  if (result === null) return t('state.bootstrapping');
  if (result.kind === 'unreachable') return t('state.unreachable', { message: result.message });
  if (result.state === 'failed') return t('state.failed', { message: result.diagnostic.message });
  return t(`state.${result.state}`);
}

/** The `signal.*` state a result without a reading reads as: no result yet and bootstrapping are still reading, an unreachable result is unreachable, and any other names its own state. */
export function resultSignalState(result) {
  return result === null || result.state === 'bootstrapping' ? 'reading' : result.kind === 'unreachable' ? 'unreachable' : result.state;
}

/** English tab and dock strings. */
export const en = {
  'view.label': 'Session Watcher',
  'state.unobserved': 'Session Watcher is not observing this session.',
  'state.bootstrapping': 'Session Watcher is reading this session…',
  'state.failed': 'Session Watcher could not measure this session: {message}',
  'state.unreachable': 'Session Watcher cannot be reached: {message}',
  'signal.connecting': 'connecting',
  'signal.live': 'live',
  'signal.disconnected': 'disconnected',
  'signal.reading': 'reading',
  'signal.unobserved': 'unobserved',
  'signal.failed': 'failed',
  'signal.unreachable': 'unreachable',
  'dock.label': 'Session Watcher readings',
  'dock.pill': 'Session Watcher: {summary}',
  'dock.separator': ', ',
  'dock.calibrating': 'Calibrating',
  'dock.br': 'Bill premium',
  'dock.clock': 'Alert clock',
  'dock.clockIdle': 'idle',
  'dock.laps': 'Alert clock laps: {count}',
  'dock.armLeft': 'Left arm: bill premium falls as the session continues',
  'dock.armRight': 'Right arm: bill premium rises as the session continues',
  'dock.insufficientData': 'Not enough data yet for a reliable reading.',
  // The zone words are the labels the dashboard's aux bar draws (`buildLabelsHTML` in public/elements/depthAux.js): shallow at its left end, sweet across the middle, deep from where red begins. Amber, the stretch just before red, is where the bar turns from sweet to deep.
  'dock.zone.white': 'Shallow',
  'dock.zone.green': 'Sweet',
  'dock.zone.amber': 'Deepening',
  'dock.zone.red': 'Deep',
  'dock.u': 'Normalized position',
  'dock.sweet': 'Sweet spot',
  'dock.stock': 'Context stock',
  'dock.baseline': 'Rebuild baseline',
  'dock.effective': 'Effective context',
  'dock.growth': 'Growth per call',
};

/** Simplified-Chinese tab and dock strings. */
export const zh = {
  'view.label': 'Session Watcher',
  'state.unobserved': 'Session Watcher 未在观测此会话。',
  'state.bootstrapping': 'Session Watcher 正在读取此会话…',
  'state.failed': 'Session Watcher 无法测量此会话：{message}',
  'state.unreachable': '无法连接 Session Watcher：{message}',
  'signal.connecting': '连接中',
  'signal.live': '实时',
  'signal.disconnected': '已断开',
  'signal.reading': '读取中',
  'signal.unobserved': '未观测',
  'signal.failed': '失败',
  'signal.unreachable': '无法连接',
  'dock.label': 'Session Watcher 读数',
  'dock.pill': 'Session Watcher：{summary}',
  'dock.separator': '，',
  'dock.calibrating': '校准中',
  'dock.br': '账单溢价',
  'dock.clock': '提醒时钟',
  'dock.clockIdle': '未启动',
  'dock.laps': '提醒时钟圈数：{count}',
  'dock.armLeft': '左臂：账单溢价随会话推进而下降',
  'dock.armRight': '右臂：账单溢价随会话推进而上升',
  'dock.insufficientData': '数据尚不足以形成可靠读数。',
  'dock.zone.white': '偏浅',
  'dock.zone.green': '甜点区',
  'dock.zone.amber': '渐深',
  'dock.zone.red': '偏深',
  'dock.u': '归一化位置',
  'dock.sweet': '甜点',
  'dock.stock': '上下文存量',
  'dock.baseline': '重建基线',
  'dock.effective': '有效上下文',
  'dock.growth': '每次调用增长',
};
