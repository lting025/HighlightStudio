'use strict';
const fs = require('node:fs');
const model = require('../docs/model.js');

function summarize(raw, info, id) {
  const data = model.parseChat(raw, {id, duration:info.duration, title:info.title || id});
  const {rows, ...video} = data;
  const report = {version:1, meta:{...video, count:rows.length}, windows:{}};
  for (const size of [15, 30, 60]) {
    report.windows[size] = model.features(data, {...model.defaults, window:size})
      .map(w => [w.count, w.users, w.effective, w.reactions, w.paid]);
  }
  return report;
}

if (require.main === module) {
  const [dir, id, output] = process.argv.slice(2);
  const file = dir + '/video.live_chat.json';
  if (!fs.existsSync(file) || fs.statSync(file).size > 128 * 1024 ** 2) {
    throw Error('聊天室不存在或超過 128 MiB');
  }
  const info = JSON.parse(fs.readFileSync(dir + '/video.info.json', 'utf8'));
  const report = summarize(fs.readFileSync(file,'utf8'), info, id);
  fs.writeFileSync(output, JSON.stringify(report));
}
module.exports = summarize;
