// server.js - 最簡版點歌系統
const express = require('express');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const DB_FILE = './requests.json';

// 初始化檔案
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify([]));
}

// 取得歌單
app.get('/api/requests', (req, res) => {
  const data = JSON.parse(fs.readFileSync(DB_FILE));
  res.json(data);
});

// 新增點歌
app.post('/api/request', (req, res) => {
  const data = JSON.parse(fs.readFileSync(DB_FILE));
  const newReq = {
    id: Date.now(),
    title: req.body.title,
    artist: req.body.artist || "",
    name: req.body.name || "",
    time: new Date().toISOString(),
  };
  data.push(newReq);
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  res.json({ success: true, request: newReq });
});

app.listen(3000, () => {
  console.log("點歌系統已啟動：http://localhost:3000");
});
const fs = require('fs');

// 讀取 queue
function getQueue() {
  if (!fs.existsSync('requests.json')) return [];
  return JSON.parse(fs.readFileSync('requests.json'));
}

// 寫入 queue
function saveQueue(q) {
  fs.writeFileSync('requests.json', JSON.stringify(q, null, 2));
}

// 取得下一首
app.get('/next', (req, res) => {
  const queue = getQueue();
  if (queue.length === 0) return res.json({ url: null });

  res.json({ url: queue[0].url });
});

// 播放完畢後移除
app.post('/finish', (req, res) => {
  let queue = getQueue();
  queue.shift();  // 移除第一首
  saveQueue(queue);
  res.json({ ok: true });
});
