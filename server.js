// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 觀眾點歌 API ----------
app.post('/request', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided' });

  let queue = [];
  if (fs.existsSync('requests.json')) {
    queue = JSON.parse(fs.readFileSync('requests.json'));
  }

  queue.push({ url });
  fs.writeFileSync('requests.json', JSON.stringify(queue, null, 2));
  res.json({ ok: true });
});

// ---------- 取得下一首 API ----------
app.get('/next', (req, res) => {
  let queue = [];
  if (fs.existsSync('requests.json')) {
    queue = JSON.parse(fs.readFileSync('requests.json'));
  }

  if (queue.length === 0) return res.json({ url: null });
  res.json({ url: queue[0].url });
});

// ---------- 播放完成移除 API ----------
app.post('/finish', (req, res) => {
  let queue = [];
  if (fs.existsSync('requests.json')) {
    queue = JSON.parse(fs.readFileSync('requests.json'));
  }

  queue.shift(); // 移除第一首
  fs.writeFileSync('requests.json', JSON.stringify(queue, null, 2));
  res.json({ ok: true });
});

// ---------- 監聽 port ----------
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
// 取得完整 queue（大螢幕顯示下一首排隊）
app.get('/queue', (req, res) => {
  let queue = [];
  if (fs.existsSync('requests.json')) {
    queue = JSON.parse(fs.readFileSync('requests.json'));
  }
  res.json(queue);
});
// 刪除指定索引的歌曲
app.post('/delete/:index', (req, res) => {
  let queue = [];
  if (fs.existsSync('requests.json')) {
    queue = JSON.parse(fs.readFileSync('requests.json'));
  }
  const idx = parseInt(req.params.index);
  if (!isNaN(idx) && idx >= 0 && idx < queue.length) {
    queue.splice(idx, 1);
    fs.writeFileSync('requests.json', JSON.stringify(queue, null, 2));
  }
  res.json({ ok: true });
});
