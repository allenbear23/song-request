// server.js
const ADMIN_USER = "allen";      // 管理員帳號
const ADMIN_PASS = "123456";     // 管理員密碼

const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // node-fetch@2

// --- Redis 設定 (用於資料持久化) ---
let redis;
const REDIS_URL = process.env.REDIS_URL;

if (REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redis = new Redis(REDIS_URL);
    redis.on('connect', () => console.log('✅ Redis 連線成功！'));
    redis.on('error', (err) => console.error('❌ Redis 連線錯誤:', err));
  } catch (e) {
    console.error("❌ 找不到 'ioredis' 套件。請執行 'npm install ioredis'");
  }
} else {
  console.log('⚠️ Redis 未啟用: 未設定 REDIS_URL 環境變數 (將使用本地檔案)');
}

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- 請把你的 API key 填在這裡 ----------
const YT_API_KEY = process.env.YT_API_KEY || "AIzaSyC665Opql5KG7wx87YOYQ3OlH9hx5JqGZ0";
// ------------------------------------------------

const USERS_FILE = 'users.json'; // 使用者統計資料檔
const BANNED_WORDS_FILE = 'banned_words.json'; // 違禁詞資料檔
const SONGS_FILE = 'songs.json'; // 歌曲統計資料檔

// 預設設定
const DEFAULT_SETTINGS = {
  threshold: 3, timeout: 60000, banDuration: 5 * 60 * 1000,
  autoQueue: true, visualEffects: true
};

app.use(express.json({ limit: '50mb' })); // 提高限制以支援圖片上傳
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 權限驗證 Middleware (Basic Auth)
function protect(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Protected Area"');
    return res.status(401).send("Authentication required.");
  }
  const base64 = auth.split(" ")[1];
  const [user, pass] = Buffer.from(base64, "base64").toString().split(":");
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Protected Area"');
  return res.status(401).send("Invalid credentials.");
}

// --- 通用資料讀寫 (支援 MongoDB 與 檔案) ---
async function readData(key, defaultVal) {
  const redisKey = key;
  
  // 優先嘗試 Redis
  if (redis && redis.status === 'ready') {
    try {
      const raw = await redis.get(redisKey);
      return raw ? JSON.parse(raw) : defaultVal;
    } catch (e) {
      console.error(`readData(${key}) Redis error:`, e);
    }
  }

  // 檔案模式 fallback (當 DB 未設定、未連線或讀取失敗時)
  let fileName;
  if (key === 'users') fileName = USERS_FILE;
  else if (key === 'queue') fileName = 'requests.json';
  else if (key === 'playlist') fileName = 'playlist.json';
  else if (key === 'bannedWords') fileName = BANNED_WORDS_FILE;
  else if (key === 'songs') fileName = SONGS_FILE;
  else if (key === 'settings') fileName = 'settings.json';
  else return defaultVal;

  try {
    if (!fs.existsSync(fileName)) return defaultVal;
    const raw = await fs.promises.readFile(fileName, 'utf8');
    return JSON.parse(raw || JSON.stringify(defaultVal));
  } catch (e) {
    return defaultVal;
  }
}

async function writeData(key, data) {
  const redisKey = key;
  
  // 優先嘗試 Redis
  if (redis && redis.status === 'ready') {
    try {
      await redis.set(redisKey, JSON.stringify(data));
      return;
    } catch (e) { console.error(`writeData(${key}) Redis error:`, e); }
  }

  // 檔案模式 fallback
  let fileName;
  if (key === 'users') fileName = USERS_FILE;
  else if (key === 'queue') fileName = 'requests.json';
  else if (key === 'playlist') fileName = 'playlist.json';
  else if (key === 'bannedWords') fileName = BANNED_WORDS_FILE;
  else if (key === 'songs') fileName = SONGS_FILE;
  else if (key === 'settings') fileName = 'settings.json';
  else return;

  try {
    await fs.promises.writeFile(fileName, JSON.stringify(data, null, 2));
  } catch (e) { console.error(`writeData(${key}) File error:`, e); }
}

// 設定快取 (避免頻繁讀檔)
let settingsCache = null;
async function getSettings() {
  if (!settingsCache) {
    settingsCache = await readData('settings', DEFAULT_SETTINGS);
    // 合併預設值以防欄位缺失
    settingsCache = { ...DEFAULT_SETTINGS, ...settingsCache };
  }
  return settingsCache;
}
async function saveSettings(newSettings) {
  const current = await getSettings();
  settingsCache = { ...current, ...newSettings };
  await writeData('settings', settingsCache);
}

// 為了相容舊程式碼的包裝 (改為 Async)
const readQueue = () => readData('queue', []);
const writeQueue = (q) => writeData('queue', q);
const readUsers = () => readData('users', {});
const writeUsers = (u) => writeData('users', u);
const readBannedWords = () => readData('bannedWords', []);
const writeBannedWords = (w) => writeData('bannedWords', w);
const readSongs = () => readData('songs', {});
const writeSongs = (s) => writeData('songs', s);

let lastSkipMessage = null;
let marquee = { text: "", timestamp: 0 };
let danmakuList = []; // 彈幕列表

function extractVideoId(url) {
  if (!url) return null;
  const m = url.match(/v=([^&]+)/);
  if (m) return m[1];
  const s = url.match(/youtu\.be\/([^?&]+)/);
  return s ? s[1] : null;
}

// Fetch full video info: title, channel, thumbnail
async function fetchVideoInfo(videoId) {
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${YT_API_KEY}`);
    const data = await res.json();
    if (data && data.items && data.items.length > 0) {
      const snip = data.items[0].snippet;
      return {
        title: snip.title,
        channel: snip.channelTitle,
        thumbnail: (snip.thumbnails && (snip.thumbnails.high || snip.thumbnails.medium || snip.thumbnails.default)).url
      };
    }
  } catch (e) {
    console.error('fetchVideoInfo error:', e);
  }
  return null;
}

// ----------------- API -----------------

// Search YouTube (server-side, uses YT API key)
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(q)}&key=${YT_API_KEY}`;
    const r = await fetch(url);
    const data = await r.json();

    if (!data.items) return res.json([]);

    const results = data.items.map(it => ({
      videoId: it.id.videoId,
      title: it.snippet.title,
      channel: it.snippet.channelTitle,
      thumbnail: it.snippet.thumbnails && (it.snippet.thumbnails.medium || it.snippet.thumbnails.default).url
    }));
    res.json(results);
  } catch (e) {
    console.error('search error:', e);
    res.json([]);
  }
});

// Request (add to queue) — accepts either full URL or videoId via url param
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET || '6LdTREMsAAAAAHaezhLTPt4ldYTyFj-rulrmYRIk';

app.post('/request', async (req, res) => {
  try {
    const { url, token, user } = req.body;

    // 驗證 token 是否送來
    if (!token) {
      return res.status(400).json({ error: 'reCAPTCHA token missing' });
    }
    
    // 檢查使用者是否被停權
    if (user && user.userId) {
      const users = await readUsers();
      if (users[user.userId] && users[user.userId].bannedUntil > Date.now()) {
        const minLeft = Math.ceil((users[user.userId].bannedUntil - Date.now()) / 60000);
        return res.status(403).json({ error: `您已被停權，請於 ${minLeft} 分鐘後再試` });
      }
    }

    // call Google verify API
    const verifyUrl = `https://www.google.com/recaptcha/api/siteverify`;
    const params = new URLSearchParams();
    params.append('secret', RECAPTCHA_SECRET);
    params.append('response', token);

    const verifyRes = await fetch(verifyUrl, { method: 'POST', body: params });
    const verifyJson = await verifyRes.json();

    // verifyJson 範例: { success: true, score: 0.9, action: "submit", ... }
    if (!verifyJson.success || (verifyJson.score !== undefined && verifyJson.score < 0.5)) {
      console.warn('reCAPTCHA failed', verifyJson);
      return res.status(400).json({ error: 'reCAPTCHA 驗證失敗 (分數過低)，請再試一次' });
    }

    // 如果你使用 reCAPTCHA v3（有 score），你可以檢查 score >= 0.5 之類：
    // if (verifyJson.score !== undefined && verifyJson.score < 0.5) { ... }

    // 驗證成功後，繼續原本的點歌流程
    // --- 以下保留你原本的解析 videoId / 重複檢查 / 加入 queue 邏輯 ---
    if (!url) return res.status(400).json({ error: 'No URL provided' });

    let videoId = extractVideoId(url);
    if (!videoId) {
      const maybeId = url.trim();
      if (/^[a-zA-Z0-9_-]{8,}$/.test(maybeId)) videoId = maybeId;
    }
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL or ID' });

    const queue = await readQueue();
    const already = queue.some(item => extractVideoId(item.url) === videoId);
    if (already) {
      return res.status(400).json({ error: '此歌曲已在排隊中，請選擇其他歌曲' });
    }

    const info = await fetchVideoInfo(videoId);
    if (!info) return res.status(500).json({ error: 'Failed to fetch video info.' });

    // 檢查違禁詞
    const bannedWords = await readBannedWords();
    for (const word of bannedWords) {
      if (info.title.includes(word)) {
        return res.status(400).json({ error: `標題包含違禁詞「${word}」，無法點歌` });
      }
    }

    // --- 記錄歌曲點播次數 ---
    const songs = await readSongs();
    if (!songs[videoId]) songs[videoId] = { count: 0 };
    songs[videoId].title = info.title;
    songs[videoId].thumbnail = info.thumbnail;
    songs[videoId].count = (songs[videoId].count || 0) + 1;
    await writeSongs(songs);

    const fullUrl = 'https://www.youtube.com/watch?v=' + videoId;
    
    // --- 記錄使用者點歌次數 ---
    if (user && user.userId) {
      const users = await readUsers();
      if (!users[user.userId]) users[user.userId] = { count: 0 };
      
      users[user.userId].name = user.displayName; // 更新最新暱稱
      users[user.userId].picture = user.pictureUrl; // 更新最新頭貼
      users[user.userId].count = (users[user.userId].count || 0) + 1;
      await writeUsers(users);
    }
    
    queue.push({ 
      url: fullUrl, 
      title: info.title, 
      channel: info.channel, 
      thumbnail: info.thumbnail,
      requester: user ? { id: user.userId, name: user.displayName } : null
    });

    // 若目前播放的是系統自動推薦歌曲，且有新點歌，則移除自動推薦歌曲 (立即切歌)
    if (queue.length > 1 && queue[0].requester && queue[0].requester.name === '系統') {
      queue.shift();
    }

    await writeQueue(queue);

    console.log('Added to queue:', info.title);
    return res.json({ ok: true, title: info.title });

  } catch (e) {
    console.error('/request error:', e);
    return res.status(500).json({ error: 'Server error: ' + e.message });
  }
});



// 自動加入推薦歌曲 (Helper)
async function autoAddSong(q) {
  try {
    const songs = await readSongs();
    const ids = Object.keys(songs);
    if (ids.length === 0) return;

    // 隨機挑選一首
    const rId = ids[Math.floor(Math.random() * ids.length)];
    const s = songs[rId];

    const newItem = {
      url: 'https://www.youtube.com/watch?v=' + rId,
      title: s.title,
      channel: "系統自動推薦",
      thumbnail: s.thumbnail,
      requester: { name: "系統" },
      votes: 0,
      votedIds: []
    };
    
    q.push(newItem);
    await writeQueue(q);
    console.log('Auto-queued:', s.title);
  } catch (e) {
    console.error('Auto queue error:', e);
  }
}

// Get next (first) item
app.get('/next', async (req, res) => {
  const q = await readQueue();
  const settings = await getSettings();
  if (q.length === 0 && settings.autoQueue) {
    await autoAddSong(q);
  }
  res.json(q.length ? q[0] : { url: null, title: null, channel: null, thumbnail: null });
});

// Finish (pop first)
app.post('/finish', async (req, res) => {
  const q = await readQueue();
  if (q.length) q.shift();
  await writeQueue(q);
  res.json({ ok: true });
});

// 檢查投票是否過期 (Helper)
async function checkVoteExpiry(q) {
  const settings = await getSettings();
  if (q.length > 0) {
    const item = q[0];
    if (item.votes && item.voteStartTime) {
      const elapsed = Date.now() - item.voteStartTime;
      if (elapsed > settings.timeout) {
        // 過期重置
        item.votes = 0;
        item.votedIds = [];
        delete item.voteStartTime;
        await writeQueue(q);
      }
    }
  }
}

// 投票切歌 API
app.post('/vote-skip', async (req, res) => {
  const q = await readQueue();
  if (q.length === 0) return res.status(400).json({ error: "目前沒有歌曲" });

  // 檢查是否過期
  await checkVoteExpiry(q);

  const item = q[0];
  
  // 初始化欄位
  if (!item.votedIds) item.votedIds = [];
  if (!item.votes) item.votes = 0;

  // 識別身分：優先使用前端傳來的 clientId，若無則退回使用 IP
  let voterId = req.body.clientId;
  if (!voterId) {
    let userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (userIp && typeof userIp === 'string' && userIp.indexOf(',') > -1) {
      userIp = userIp.split(',')[0].trim();
    }
    voterId = userIp;
  }

  // 檢查使用者是否被停權
  const users = await readUsers();
  if (users[voterId] && users[voterId].bannedUntil > Date.now()) {
    const minLeft = Math.ceil((users[voterId].bannedUntil - Date.now()) / 60000);
    return res.status(403).json({ error: `您已被停權，無法投票。請於 ${minLeft} 分鐘後再試` });
  }

  if (item.votedIds.includes(voterId)) {
    return res.status(400).json({ error: "您已經投過票了" });
  }

  // 第一次投票設定開始時間
  if (item.votes === 0) item.voteStartTime = Date.now();

  item.votedIds.push(voterId);
  item.votes = (item.votes || 0) + 1;

  const settings = await getSettings();
  if (item.votes >= settings.threshold) {
    // 執行停權 (5分鐘)
    if (item.requester && item.requester.id) {
      const users = await readUsers();
      if (!users[item.requester.id]) users[item.requester.id] = {};
      users[item.requester.id].bannedUntil = Date.now() + settings.banDuration;
      await writeUsers(users);
    }

    // 設定切歌訊息供前端顯示
    lastSkipMessage = {
      type: 'vote',
      title: item.title,
      requester: item.requester ? item.requester.name : '未知',
      banDuration: Math.ceil(settings.banDuration / 60000),
      timestamp: Date.now()
    };

    q.shift(); // 移除目前歌曲
    await writeQueue(q);
    return res.json({ ok: true, message: "票數已達，切歌！", skipped: true });
  }

  await writeQueue(q);
  res.json({ ok: true, message: "投票成功", votes: item.votes });
});

// Get full queue
app.get('/queue', async (req, res) => {
  const q = await readQueue();
  await checkVoteExpiry(q); // 讀取時順便檢查過期
  res.json(q);
});

// 排行榜 API
app.get('/leaderboard', async (req, res) => {
  const users = await readUsers();
  // 轉為陣列並排序
  const list = Object.values(users).map(u => ({
    name: u.name,
    picture: u.picture,
    count: u.count
  }));
  list.sort((a, b) => b.count - a.count); // 由大到小排序
  res.json(list.slice(0, 20)); // 只回傳前 20 名
});

// 歌曲排行榜 API (Songs)
app.get('/leaderboard/songs', async (req, res) => {
  const songs = await readSongs();
  const list = Object.values(songs).map(s => ({
    title: s.title,
    thumbnail: s.thumbnail,
    count: s.count
  }));
  list.sort((a, b) => b.count - a.count);
  res.json(list.slice(0, 20));
});

// Delete by index
app.post('/delete/:index', async (req, res) => {
  const idx = parseInt(req.params.index);
  const q = await readQueue();
  if (!isNaN(idx) && idx >= 0 && idx < q.length) {
    q.splice(idx, 1);
    await writeQueue(q);
  }
  res.json({ ok: true });
});

app.get('/playlist', async (req, res) => {
  const list = await readData('playlist', []);
  res.json(list);
});

app.post('/playlist/save', async (req, res) => {
  try {
    const q = await readQueue();
    await writeData('playlist', q);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "save playlist error" });
  }
});

app.post('/playlist/load', async (req, res) => {
  try {
    const playlist = await readData('playlist', []);
    if (!playlist || playlist.length === 0) return res.json({ ok: false });
    
    await writeQueue(playlist);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "load playlist error" });
  }
});

app.post('/playlist/clear', async (req, res) => {
  try {
    await writeData('playlist', []);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "clear playlist error" });
  }
});

// 取得設定 (公開)
app.get('/settings', async (req, res) => {
  const settings = await getSettings();
  res.json({ 
    threshold: settings.threshold, 
    timeout: settings.timeout, 
    banDuration: settings.banDuration / 60000, 
    autoQueue: settings.autoQueue,
    visualEffects: settings.visualEffects
  });
});

// 修改門檻 (管理員)
app.post('/admin/threshold', protect, async (req, res) => {
  const val = parseInt(req.body.threshold);
  if (val && val > 0) {
    await saveSettings({ threshold: val });
    const s = await getSettings();
    res.json({ ok: true, threshold: s.threshold });
  } else {
    res.status(400).json({ error: "無效的數值" });
  }
});

// 修改停權時間 (管理員)
app.post('/admin/ban-duration', protect, async (req, res) => {
  const val = parseInt(req.body.banDuration);
  if (val && val > 0) {
    await saveSettings({ banDuration: val * 60 * 1000 });
    res.json({ ok: true, banDuration: val });
  } else {
    res.status(400).json({ error: "無效的數值" });
  }
});

// 修改自動推薦開關 (管理員)
app.post('/admin/auto-queue', protect, async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled === 'boolean') {
    await saveSettings({ autoQueue: enabled });
    res.json({ ok: true, autoQueue: enabled });
  } else {
    res.status(400).json({ error: "Invalid value" });
  }
});

// 修改舞台燈光特效開關 (管理員)
app.post('/admin/visual-effects', protect, async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled === 'boolean') {
    await saveSettings({ visualEffects: enabled });
    res.json({ ok: true, visualEffects: enabled });
  } else {
    res.status(400).json({ error: "Invalid value" });
  }
});

// 更改順序 (管理員)
app.post('/admin/reorder', protect, async (req, res) => {
  const { oldIndex, newIndex } = req.body;
  const q = await readQueue();
  if (
    typeof oldIndex === 'number' && oldIndex >= 0 && oldIndex < q.length &&
    typeof newIndex === 'number' && newIndex >= 0 && newIndex < q.length
  ) {
    const [item] = q.splice(oldIndex, 1);
    q.splice(newIndex, 0, item);
    await writeQueue(q);
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: "無效的索引" });
  }
});

// 管理員強制切歌 (帶原因與圖片)
app.post('/admin/skip', protect, async (req, res) => {
  const { reason, image } = req.body;
  const q = await readQueue();
  const settings = await getSettings();
  
  // 執行切歌邏輯
  let skippedItem = null;
  if (q.length > 0) {
    skippedItem = q.shift();
    await writeQueue(q);

    // 執行停權 (5分鐘)
    if (skippedItem.requester && skippedItem.requester.id) {
      const users = await readUsers();
      if (!users[skippedItem.requester.id]) users[skippedItem.requester.id] = {};
      users[skippedItem.requester.id].bannedUntil = Date.now() + settings.banDuration;
      await writeUsers(users);
    }
  }

  // 紀錄訊息供前端顯示
  lastSkipMessage = {
    type: 'admin',
    reason: reason || '',
    image: image || null,
    title: skippedItem ? skippedItem.title : '',
    requester: (skippedItem && skippedItem.requester) ? skippedItem.requester.name : '未知',
    banDuration: Math.ceil(settings.banDuration / 60000),
    timestamp: Date.now()
  };

  res.json({ ok: true });
});

// 取得停權名單 (管理員)
app.get('/admin/banned-users', protect, async (req, res) => {
  const users = await readUsers();
  const now = Date.now();
  const list = [];
  
  Object.keys(users).forEach(userId => {
    const u = users[userId];
    if (u.bannedUntil && u.bannedUntil > now) {
      list.push({
        id: userId,
        name: u.name,
        picture: u.picture,
        bannedUntil: u.bannedUntil
      });
    }
  });
  
  res.json(list);
});

// 解除停權 (管理員)
app.post('/admin/unban', protect, async (req, res) => {
  const { userId } = req.body;
  const users = await readUsers();
  
  if (users[userId]) {
    delete users[userId].bannedUntil;
    await writeUsers(users);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "找不到使用者" });
  }
});

// --- 違禁詞管理 API ---
app.get('/admin/banned-words', protect, async (req, res) => {
  const words = await readBannedWords();
  res.json(words);
});

app.post('/admin/banned-words/add', protect, async (req, res) => {
  const { word } = req.body;
  if (!word || !word.trim()) return res.status(400).json({ error: "請輸入違禁詞" });
  
  const words = await readBannedWords();
  if (!words.includes(word)) {
    words.push(word);
    await writeBannedWords(words);
  }
  res.json({ ok: true });
});

app.post('/admin/banned-words/remove', protect, async (req, res) => {
  const { word } = req.body;
  const words = await readBannedWords();
  const newWords = words.filter(w => w !== word);
  await writeBannedWords(newWords);
  res.json({ ok: true });
});


// 取得最新的切歌訊息
app.get('/skip-message', (req, res) => res.json(lastSkipMessage || {}));

// --- 公告跑馬燈 API ---
app.post('/admin/marquee', protect, async (req, res) => {
  const { text } = req.body;
  // 若 text 為空字串則代表清除
  marquee = { text: text || "", timestamp: Date.now() };
  res.json({ ok: true });
});

app.get('/marquee', (req, res) => {
  res.json(marquee || { text: "" });
});

// --- 彈幕 API ---
app.post('/danmaku', async (req, res) => {
  const { text, color, size, mode, quantity } = req.body;
  if (!text) return res.status(400).json({ error: "Empty text" });
  
  // 限制數量在 1 ~ 20 之間
  const count = Math.max(1, Math.min(parseInt(quantity) || 1, 20));

  for (let i = 0; i < count; i++) {
    const msg = {
      text: String(text).substring(0, 50), // 限制長度
      color: color || '#ffffff',
      size: size || 'medium',
      mode: mode || 'scroll',
      timestamp: Date.now() + i // 加上微小時間差確保順序
    };
    danmakuList.push(msg);
  }
  
  // 保留最近 100 則，避免記憶體膨脹
  if (danmakuList.length > 100) {
    danmakuList = danmakuList.slice(-100);
  }
  
  res.json({ ok: true });
});

app.get('/danmaku', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  // 回傳比 since 新的訊息
  const newMsgs = danmakuList.filter(m => m.timestamp > since);
  res.json(newMsgs);
});

app.use((req, res, next) => {
  next();
});


// health
app.get('/health', (req, res) => {
  const dbStatus = (redis && redis.status === 'ready') ? 'connected' : 'disconnected';
  res.json({ ok: true, db: dbStatus });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
