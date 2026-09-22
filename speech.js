// 说出来：浏览器自带语音识别（Chrome / Edge / Safari 有，Firefox 没有；国内 Chrome 连不上谷歌会报 network）。认不了就退回「自己判」
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let off = !SR; // 这次打开里识别坏过（没权限 / 连不上）就不再试，整场改自己判
export const canListen = () => !off;
const WHY = { 'not-allowed': '没有麦克风权限', 'service-not-allowed': '没有麦克风权限', network: '连不上语音识别服务', 'audio-capture': '找不到麦克风', 'no-speech': '没听到声音，再说一次' };
// 听一句（long = 一直听到 stop()，给「描述这张图」口述用）。done 给出识别到的候选句子数组
export function listen(tag, long) {
  const r = new SR();
  r.lang = tag; r.maxAlternatives = 5; r.interimResults = false; r.continuous = !!long;
  const done = new Promise((res, rej) => {
    const got = [];
    r.onresult = e => {
      if (long) { for (let k = e.resultIndex; k < e.results.length; k++) if (e.results[k].isFinal) got.push(e.results[k][0].transcript); }
      else got.splice(0, got.length, ...[...e.results[0]].map(a => a.transcript));
    };
    r.onerror = e => {
      if (e.error === 'aborted') return;
      if (['not-allowed', 'service-not-allowed', 'network', 'audio-capture'].includes(e.error)) off = true;
      rej(new Error(WHY[e.error] || '语音识别出错：' + e.error));
    };
    r.onend = () => res(long ? [got.join(' ')] : got);
  });
  r.start();
  return { done, stop: () => r.stop() };
}
