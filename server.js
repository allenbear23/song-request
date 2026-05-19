// server.js
const express = require('express');
const yts = require('yt-search');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // node-fetch@2
require('dotenv').config();

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

// ---------- 請把你的 API key 填入 .env 檔案 ----------
const YT_API_KEY = process.env.YT_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// ------------------------------------------------

const USERS_FILE = 'users.json'; // 使用者統計資料檔
const BANNED_WORDS_FILE = 'banned_words.json'; // 違禁詞資料檔
const SONGS_FILE = 'songs.json'; // 歌曲統計資料檔
const ADMIN_ROOMS_FILE = 'admin_rooms.json'; // 管理員與房間對應檔

// 預設設定
const DEFAULT_SETTINGS = {
  threshold: 3, timeout: 60000, banDuration: 5 * 60 * 1000,
  autoQueue: true, volume: 100, readAloud: false, strictMusicOnly: false
};

app.use(express.json({ limit: '50mb' })); // 提高限制以支援圖片上傳
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 公開設定 API：供前端拿取 UI 必須的 KEY (例如 LIFF ID, reCAPTCHA site key)
app.get('/api/config', (req, res) => {
  res.json({
    RECAPTCHA_SITE_KEY: process.env.RECAPTCHA_SITE_KEY,
    LIFF_ID: process.env.LIFF_ID
  });
});

// 取得房間 ID (預設為 'default')
function getRoom(req) {
  return req.query.room || req.body.room || 'default';
}

const recommendingRooms = new Set();
let ytQuotaExceededUntil = 0; // 記錄 YouTube Quota 耗盡的時間點

// YouTube API Key 輪替管理
const ytKeys = (process.env.YT_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
let currentYTKeyIndex = 0;
const exhaustedKeys = new Set(); // 記錄當天已耗盡的 Key

function getCurrentYTKey() {
  if (ytKeys.length === 0) return null;
  return ytKeys[currentYTKeyIndex];
}

function rotateYTKey() {
  if (ytKeys.length === 0) return;
  
  const currentKey = ytKeys[currentYTKeyIndex];
  exhaustedKeys.add(currentKey);
  
  console.log(`[YT Quota] Key ${currentYTKeyIndex + 1} exhausted. Rotating...`);
  
  // 尋找下一個還沒被標記為耗盡的 Key
  for (let i = 0; i < ytKeys.length; i++) {
    currentYTKeyIndex = (currentYTKeyIndex + 1) % ytKeys.length;
    if (!exhaustedKeys.has(ytKeys[currentYTKeyIndex])) {
      console.log(`[YT Quota] Switched to Key ${currentYTKeyIndex + 1}.`);
      return true;
    }
  }
  
  // 如果所有 Key 都試過了
  console.error('❌ All YouTube API Keys exhausted for today.');
  ytQuotaExceededUntil = Date.now() + 60 * 60 * 1000;
  return false;
}

// 每小時嘗試重置一次耗盡清單 (或者根據需求手動重置)
setInterval(() => {
  if (exhaustedKeys.size > 0 && Date.now() > ytQuotaExceededUntil) {
    console.log('[YT Quota] Resetting exhausted keys list for a new attempt.');
    exhaustedKeys.clear();
    ytQuotaExceededUntil = 0;
  }
}, 60 * 60 * 1000);

// 權限驗證 (暫時開放，為了讓使用者快速上手)
const protect = (req, res, next) => next();

// --- 通用資料讀寫 (支援 MongoDB 與 檔案) ---
async function readData(key, room, defaultVal) {
  const redisKey = key === 'admin_rooms' ? 'global:admin_rooms' : `room:${room}:${key}`;

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
  const isDefault = room === 'default';
  let fileName;
  if (key === 'admin_rooms') fileName = ADMIN_ROOMS_FILE;
  else if (key === 'users') fileName = isDefault ? USERS_FILE : `users_${room}.json`;
  else if (key === 'queue') fileName = isDefault ? 'requests.json' : `requests_${room}.json`;
  else if (key === 'playlist') fileName = isDefault ? 'playlist.json' : `playlist_${room}.json`;
  else if (key === 'history') fileName = isDefault ? 'history.json' : `history_${room}.json`;
  else if (key === 'bannedWords') fileName = isDefault ? BANNED_WORDS_FILE : `banned_words_${room}.json`;
  else if (key === 'songs') fileName = isDefault ? SONGS_FILE : `songs_${room}.json`;
  else if (key === 'settings') fileName = isDefault ? 'settings.json' : `settings_${room}.json`;
  else return defaultVal;

  try {
    if (!fs.existsSync(fileName)) return defaultVal;
    const raw = await fs.promises.readFile(fileName, 'utf8');
    return JSON.parse(raw || JSON.stringify(defaultVal));
  } catch (e) {
    return defaultVal;
  }
}

async function writeData(key, room, data) {
  const redisKey = key === 'admin_rooms' ? 'global:admin_rooms' : `room:${room}:${key}`;

  // 優先嘗試 Redis
  if (redis && redis.status === 'ready') {
    try {
      await redis.set(redisKey, JSON.stringify(data));
      return;
    } catch (e) { console.error(`writeData(${key}) Redis error:`, e); }
  }

  // 檔案模式 fallback
  const isDefault = room === 'default';
  let fileName;
  if (key === 'admin_rooms') fileName = ADMIN_ROOMS_FILE;
  else if (key === 'users') fileName = isDefault ? USERS_FILE : `users_${room}.json`;
  else if (key === 'queue') fileName = isDefault ? 'requests.json' : `requests_${room}.json`;
  else if (key === 'playlist') fileName = isDefault ? 'playlist.json' : `playlist_${room}.json`;
  else if (key === 'history') fileName = isDefault ? 'history.json' : `history_${room}.json`;
  else if (key === 'bannedWords') fileName = isDefault ? BANNED_WORDS_FILE : `banned_words_${room}.json`;
  else if (key === 'songs') fileName = isDefault ? SONGS_FILE : `songs_${room}.json`;
  else if (key === 'settings') fileName = isDefault ? 'settings.json' : `settings_${room}.json`;
  else return;

  try {
    await fs.promises.writeFile(fileName, JSON.stringify(data, null, 2));
    console.log(`[writeData] Successfully wrote ${key} to ${fileName}`);
  } catch (e) { console.error(`writeData(${key}) File error:`, e); }
}

// 設定快取 (避免頻繁讀檔)
const settingsCache = {};
async function getSettings(room) {
  if (!settingsCache[room]) {
    settingsCache[room] = await readData('settings', room, DEFAULT_SETTINGS);
    // 合併預設值以防欄位缺失
    settingsCache[room] = { ...DEFAULT_SETTINGS, ...settingsCache[room] };
  }
  return settingsCache[room];
}
async function saveSettings(room, newSettings) {
  const current = await getSettings(room);
  settingsCache[room] = { ...current, ...newSettings };
  await writeData('settings', room, settingsCache[room]);
}

// 為了相容舊程式碼的包裝 (改為 Async)
const readQueue = (room) => readData('queue', room, []);
const writeQueue = (room, q) => writeData('queue', room, q);
const readUsers = (room) => readData('users', room, {});
const writeUsers = (room, u) => writeData('users', room, u);
const readBannedWords = (room) => readData('bannedWords', room, []);
const writeBannedWords = (room, w) => writeData('bannedWords', room, w);
const readSongs = (room) => readData('songs', room, {});
const writeSongs = (room, s) => writeData('songs', room, s);
const readHistory = (room) => readData('history', room, []);
const writeHistory = (room, h) => writeData('history', room, h);

// 輔助函數：將歌曲存入本地資料庫
async function saveToLocalDatabase(room, items) {
  try {
    const songs = await readSongs(room);
    let changed = false;
    for (const item of items) {
      const vId = item.videoId || extractVideoId(item.url || '');
      if (!vId) continue;
      if (!songs[vId]) {
        songs[vId] = { 
          title: item.title,
          thumbnail: item.thumbnail,
          channel: item.channel,
          url: item.url || `https://www.youtube.com/watch?v=${vId}`,
          count: 0,
          addedBy: item.requester ? (item.requester.name || 'AI DJ') : 'AI DJ'
        };
        changed = true;
      }
      if (item.requester && item.requester.name !== '系統') {
        songs[vId].count = (songs[vId].count || 0) + 1;
        changed = true;
      }
    }
    if (changed) await writeSongs(room, songs);
  } catch (e) {
    console.error('saveToLocalDatabase error:', e);
  }
}

// Record a song into the auto-tracked history, holding max 20 items.
async function pushToHistory(room, item) {
  if (!item) {
    console.log(`[pushToHistory] No item provided for room ${room}`);
    return;
  }
  try {
    console.log(`[pushToHistory] Adding "${item.title}" to history of room ${room}`);
    const history = await readHistory(room);
    history.push(item);
    if (history.length > 100) history.shift(); // Keep last 100 songs
    await writeHistory(room, history);
  } catch (e) {
    console.error('pushToHistory error:', e);
  }
}

const lastSkipMessages = {}; // { room: message }
const marquees = {}; // { room: { text, timestamp } }
const danmakuLists = {}; // { room: [] }

function extractVideoId(url) {
  if (!url) return null;
  const m = url.match(/v=([^&]+)/);
  if (m) return m[1];
  const s = url.match(/youtu\.be\/([^?&]+)/);
  return s ? s[1] : null;
}

// Helper: Parse ISO 8601 duration to seconds
function parseISO8601Duration(duration) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1]) || 0;
  const minutes = parseInt(match[2]) || 0;
  const seconds = parseInt(match[3]) || 0;
  return (hours * 3600) + (minutes * 60) + seconds;
}

// Fetch full video info: title, channel, thumbnail
async function fetchVideoInfo(videoId, strictMusicOnly = false) {
  try {
    const currentKey = getCurrentYTKey();
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${currentKey}`);
    const data = await res.json();
    if (data.error) {
      if (data.error.message.includes('quota')) {
        rotateYTKey();
      }
      return { error: 'YouTube API error' };
    }
    if (data && data.items && data.items.length > 0) {
      const item = data.items[0];
      const snip = item.snippet;

      // 檢查年齡限制
      const rating = item.contentDetails && item.contentDetails.contentRating;
      if (rating && rating.ytRating === 'ytAgeRestricted') {
        return { error: '此影片設有年齡限制，無法在背景播放器中播放' };
      }

      // 嚴格音樂模式：檢查分類是否為音樂 (categoryId = 10) 以及長度是否過長 (超過 10 分鐘)
      if (strictMusicOnly) {
        if (snip.categoryId !== '10') {
          return { error: '此影片非音樂內容 (已啟用嚴格音樂模式)' };
        }
        const durationSec = parseISO8601Duration(item.contentDetails.duration || 'PT0S');
        if (durationSec > 600) {
          return { error: '此影片時長超過 10 分鐘，無法點播 (已啟用嚴格音樂模式)' };
        }
      }

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

// 建立/登入房間 API
app.post('/api/room/create', async (req, res) => {
  const { adminLineId } = req.body;
  if (!adminLineId) return res.status(400).json({ error: "資料不完整" });

  const adminRooms = await readData('admin_rooms', 'global', {});
  let assignedRoom = adminRooms[adminLineId];

  if (!assignedRoom) {
    assignedRoom = Math.random().toString(36).substring(2, 8).toUpperCase();
    adminRooms[adminLineId] = assignedRoom;
    await writeData('admin_rooms', 'global', adminRooms);
    await saveSettings(assignedRoom, { adminLineId });
  }

  return res.json({ ok: true, room: assignedRoom, message: "進入您的專屬房間" });
});

// 驗證房間管理權限 API
app.get('/api/room/login', async (req, res) => {
  const room = getRoom(req);
  const clientLineId = req.headers['x-line-user-id'];

  const settings = await getSettings(room);

  // 如果房間有設定管理員 LINE ID
  if (settings.adminLineId) {
    if (settings.adminLineId === clientLineId) {
      return res.json({ ok: true });
    } else {
      return res.status(401).json({ error: "權限不足 (非此房間管理員)" });
    }
  }

  // 如果沒設定管理員 (舊房間或開放房間)，允許
  res.json({ ok: true });
});

// Search YouTube (server-side, uses YT API key)
app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const room = getRoom(req);

  // 如果 Quota 已耗盡，使用 yt-search 作為終極備援 (無須 API Key)
  if (Date.now() < ytQuotaExceededUntil) {
    console.log(`[Search] YouTube Quota active. Using yt-search scraper fallback for: ${q}`);
    try {
      const r = await yts(q);
      const videos = r.videos.slice(0, 8).map(v => ({
        videoId: v.videoId,
        title: `(備援) ${v.title}`,
        channel: v.author.name,
        thumbnail: v.thumbnail,
        publishedAt: v.ago || '未知時間'
      }));
      if (videos.length > 0) return res.json(videos);
    } catch (e) {
      console.error('yt-search error:', e);
    }
    
    // 如果連 scraper 都失敗，才回傳本地庫存
    const allSongs = await readSongs(room);
    const localResults = Object.values(allSongs)
      .filter(s => s.title.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 8)
      .map(s => ({
        videoId: extractVideoId(s.url || ''),
        title: `(本地庫存) ${s.title}`,
        channel: s.channel || '先前播放過',
        thumbnail: s.thumbnail,
        publishedAt: new Date().toISOString()
      }));
    return res.json(localResults);
  }

  try {
    // 1. 先用 search API 取得影片清單
    const currentKey = getCurrentYTKey();
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(q)}&key=${currentKey}`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (searchData.error) {
      if (searchData.error.message.includes('quota')) {
        if (rotateYTKey()) {
           return res.redirect(`/search?q=${encodeURIComponent(q)}&room=${encodeURIComponent(req.query.room || 'default')}`);
        }
      }
      
      // Fallback: 搜尋本地已存在的歌單
      console.log(`[Search Fallback] Searching local library for: ${q}`);
      const allSongs = await readSongs(room);
      const localResults = Object.values(allSongs)
        .filter(s => s.title.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 8)
        .map(s => ({
          videoId: extractVideoId(s.url || ''),
          title: `(本地) ${s.title}`,
          channel: s.channel || '已播放過',
          thumbnail: s.thumbnail,
          publishedAt: new Date().toISOString()
        }));
      return res.json(localResults);
    }

    if (!searchData.items || searchData.items.length === 0) return res.json([]);

    // 2. 收集所有 videoId，再呼叫 videos API 取得統計資料 (包含觀看次數 snippet 包含發布時間)
    const videoIds = searchData.items.map(it => it.id.videoId).join(',');
    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoIds}&key=${currentKey}`;
    const videosRes = await fetch(videosUrl);
    const videosData = await videosRes.json();

    if (!videosData.items) return res.json([]);

    // 3. 過濾掉有年齡限制的影片，並組合資料
    const results = videosData.items
      .filter(it => {
        // 檢查是否有 ytAgeRestricted 標籤
        const rating = it.contentDetails && it.contentDetails.contentRating;
        return !(rating && rating.ytRating === 'ytAgeRestricted');
      })
      .map(it => ({
        videoId: it.id,
        title: it.snippet.title,
        channel: it.snippet.channelTitle,
        thumbnail: it.snippet.thumbnails && (it.snippet.thumbnails.medium || it.snippet.thumbnails.default).url,
        viewCount: it.statistics.viewCount,
        publishedAt: it.snippet.publishedAt
      }));

    res.json(results);
  } catch (e) {
    console.error('search error:', e);
    res.json([]);
  }
});

// Request (add to queue) — accepts either full URL or videoId via url param
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET;

app.post('/request', async (req, res) => {
  try {
    const { url, token, user } = req.body;
    const room = getRoom(req);

    // 檢查使用者是否被停權
    if (user && user.userId) {
      const users = await readUsers(room);
      if (users[user.userId] && users[user.userId].bannedUntil > Date.now()) {
        const minLeft = Math.ceil((users[user.userId].bannedUntil - Date.now()) / 60000);
        return res.status(403).json({ error: `您已被停權，請於 ${minLeft} 分鐘後再試` });
      }
    }

    // 驗證 token 是否送來 (如果 token 是 'bypass_recaptcha' 且未設定 RECAPTCHA_SECRET，則 Bypass)
    const isBypass = token === 'bypass_recaptcha' || !RECAPTCHA_SECRET;

    if (!isBypass) {
      if (!token) {
        return res.status(400).json({ error: 'reCAPTCHA token missing' });
      }

      // call Google verify API
      const verifyUrl = `https://www.google.com/recaptcha/api/siteverify`;
      const params = new URLSearchParams();
      params.append('secret', RECAPTCHA_SECRET);
      params.append('response', token);

      const verifyRes = await fetch(verifyUrl, { method: 'POST', body: params });
      const verifyJson = await verifyRes.json();

      // 檢查是否為本地測試員 (Bypass Login)
      const isLocalTest = user && user.displayName === '本地測試員';

      // verifyJson 範例: { success: true, score: 0.9, action: "submit", ... }
      if (!isLocalTest && (!verifyJson.success || (verifyJson.score !== undefined && verifyJson.score < 0.5))) {
        console.warn('reCAPTCHA failed', verifyJson);
        return res.status(400).json({ error: 'reCAPTCHA 驗證失敗 (分數過低)，請再試一次' });
      }
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

    const queue = await readQueue(room);
    const already = queue.some(item => extractVideoId(item.url) === videoId);
    if (already) {
      return res.status(400).json({ error: '此歌曲已在排隊中，請選擇其他歌曲' });
    }

    const settings = await getSettings(room);
    const info = await fetchVideoInfo(videoId, settings.strictMusicOnly);
    if (!info) return res.status(500).json({ error: 'Failed to fetch video info.' });
    if (info.error) return res.status(400).json({ error: info.error });

    // 檢查違禁詞
    const bannedWords = await readBannedWords(room);
    for (const word of bannedWords) {
      if (info.title.includes(word)) {
        return res.status(400).json({ error: `標題包含違禁詞「${word}」，無法點歌` });
      }
    }

    // --- 記錄歌曲點播次數 ---
    await saveToLocalDatabase(room, [{
      videoId: videoId,
      title: info.title,
      thumbnail: info.thumbnail,
      channel: info.channelTitle,
      requester: { name: user ? user.displayName : '訪客' }
    }]);

    const fullUrl = 'https://www.youtube.com/watch?v=' + videoId;

    // --- 記錄使用者點歌次數 ---
    if (user && user.userId) {
      const users = await readUsers(room);
      if (!users[user.userId]) users[user.userId] = { count: 0 };

      users[user.userId].name = user.displayName; // 更新最新暱稱
      users[user.userId].picture = user.pictureUrl; // 更新最新頭貼
      users[user.userId].count = (users[user.userId].count || 0) + 1;
      await writeUsers(room, users);
    }

    // 移除所有尚未播放的系統推薦歌曲 (index 1 起)
    for (let i = queue.length - 1; i > 0; i--) {
      if (queue[i].requester && queue[i].requester.name === '系統') {
        queue.splice(i, 1);
      }
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

    await writeQueue(room, queue);

    console.log('Added to queue:', info.title);
    return res.json({ ok: true, title: info.title });

  } catch (e) {
    console.error('/request error:', e);
    return res.status(500).json({ error: 'Server error: ' + e.message });
  }
});



// 使用 Hugging Face 模型檢查文字是否包含不當內容
async function checkIfInappropriate(text) {
  const hfApiKey = process.env.HF_API_KEY;
  if (!hfApiKey) return false; // 如果沒有 API Key，則略過檢查

  try {
    const response = await fetch(
      "https://api-inference.huggingface.co/models/cardiffnlp/twitter-roberta-base-hate-latest",
      {
        headers: {
          Authorization: `Bearer ${hfApiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({ inputs: text }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`Hugging Face API (Toxicity) returned status: ${response.status}. Body: ${errorText}`);
      return false;
    }

    const result = await response.json();

    // Hugging Face 回傳的格式通常為 [[{label: 'toxic', score: 0.8}, ...]]
    if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
      for (const item of result[0]) {
        if (['toxic', 'severe_toxic', 'obscene', 'threat', 'insult', 'identity_hate'].includes(item.label.toLowerCase())) {
          if (item.score > 0.5) {
            console.log(`Text "${text}" flagged as inappropriate due to ${item.label} (${item.score})`);
            return true;
          }
        }
      }
    }
    return false;
  } catch (e) {
    console.error('Hugging Face API error:', e);
    return false;
  }
}

// ================================================================
// 真正的 AI 推薦核心函數
// ================================================================

// 輔助函數：標準化歌名用於防重複比較
function normalizeTitle(title) {
  if (!title) return '';
  return title.toLowerCase()
    .replace(/official\s+music\s+video/gi, '')
    .replace(/official\s+mv/gi, '')
    .replace(/music\s+video/gi, '')
    .replace(/官方完整版/g, '')
    .replace(/官方/g, '')
    .replace(/mv/gi, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '') // 只保留英數字和中文字
    .trim();
}

// 輔助函數：模糊重複歌名檢查 (防各種翻唱、不同版本重複上架)
function isDuplicateTitle(candidateTitle, historyTitles) {
  const normCand = normalizeTitle(candidateTitle);
  if (!normCand) return true;
  
  for (const histTitle of historyTitles) {
    const normHist = normalizeTitle(histTitle);
    if (!normHist) continue;
    
    // 如果一個是另一個的子字串，代表極可能是重複歌曲 (如 "告白氣球" 與 "周杰倫 - 告白氣球")
    if (normCand.includes(normHist) || normHist.includes(normCand)) {
      return true;
    }
  }
  return false;
}

// 輔助函數：過濾掉非官方、Cover 翻唱、現場版、新聞等影片，只保留官方 MV
function isOfficialMV(title, channel) {
  const t = (title || '').toLowerCase();
  const c = (channel || '').toLowerCase();
  
  // 1. 排除非音樂/新聞黑名單
  const blacklist = [
    '新聞', '直播', 'live', '即時', '報導', '政論', '三立', 'tvbs', '東森', '中天', 
    '民視', '年代', '非凡', '壹電視', '中視', '台視', '華視', '精華', '談話', 'podcast', 
    '訪談', '訪談節目', '記者會', '大現場', '新聞網', '新聞台'
  ];
  for (const word of blacklist) {
    if (t.includes(word) || c.includes(word)) return false;
  }
  
  // 2. 排除非官方/翻唱/非純 MV 關鍵字
  const unofficialKeywords = [
    'cover', '翻唱', 'lyrics', '歌詞', 'remix', 'live', '現場', '演奏', '純音樂', 
    'instrumental', 'fanmade', 'fan-made', '混音', '慢速', '加速', 'speed up', 'slowed',
    '翻唱版', '現場版', '演唱會', 'concert', 'fancam', '直拍', '1hour', '1小時', 
    '循環', '重播', '合集', '歌單', 'playlist', '反應', 'reaction', '解析', '評論',
    '教學', 'tutorial', '伴奏', 'karaoke', '卡拉ok'
  ];
  for (const word of unofficialKeywords) {
    if (t.includes(word)) return false;
  }
  
  // 3. 必須包含官方 MV 指標字眼，或者頻道是官方發行/唱片公司頻道
  const officialKeywords = [
    'mv', 'music video', '官方', 'official', '完整版', '主打', '首播', '原聲帶', 'ost'
  ];
  const officialChannels = [
    'official', 'vevo', 'music', 'records', '唱片', '娛樂', '公司', '音樂', '工作室', 'studio'
  ];
  
  const hasOfficialTitle = officialKeywords.some(word => t.includes(word));
  const hasOfficialChannel = officialChannels.some(word => c.includes(word));
  
  // 若兩者皆無，則視為非官方影片
  if (!hasOfficialTitle && !hasOfficialChannel) {
    return false;
  }
  
  return true;
}

// 用影片標題關鍵字搜尋相關影片 (含 Quota 檢查)
async function fetchRelatedVideos(seedTitle, maxResults = 15) {
  if (!seedTitle || !YT_API_KEY) return [];
  if (Date.now() < ytQuotaExceededUntil) {
    console.warn('[AI Discovery] YouTube Quota exceeded. Skipping API call.');
    return [];
  }

  try {
    const cleanTitle = seedTitle.replace(/[\[\]\(\)\-\|]/g, ' ').trim();
    console.log(`[AI Discovery] Searching for similar content: ${cleanTitle}`);
    
    // 將 enforceOfficial 設為 true，強制推薦官方 MV
    const searchResults = await searchYouTubeServerSide(cleanTitle, true, true);
    return searchResults ? searchResults.slice(0, maxResults) : [];
  } catch (e) {
    console.error('fetchRelatedVideos error:', e);
    return [];
  }
}

// 從收聽歷史挑一個種子影片 ID
async function fetchSeedVideoIdFromHistory(room) {
  try {
    const history = await readHistory(room);
    const songs = await readSongs(room);

    const recentWithUrl = history.filter(h => h.url).slice(-5).reverse();
    if (recentWithUrl.length > 0) {
      const pick = recentWithUrl[Math.floor(Math.random() * Math.min(3, recentWithUrl.length))];
      const vid = extractVideoId(pick.url);
      if (vid) return vid;
    }

    const topSongs = Object.entries(songs).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
    if (topSongs.length > 0) {
      return topSongs[Math.floor(Math.random() * topSongs.length)][0];
    }
  } catch (e) {
    console.error('fetchSeedVideoIdFromHistory error:', e);
  }
  return null;
}

// 用 Gemini AI 對候選影片智能排序，並生成中文推薦理由
async function rankWithGemini(currentSongTitle, candidates, historyTitles, retryCount = 0) {
  if (!GEMINI_API_KEY || candidates.length === 0) {
    return candidates.map(c => ({ ...c, reason: '根據您的收聽習慣推薦', aiPicked: false }));
  }
  try {
    const candidateList = candidates.slice(0, 12).map((c, i) =>
      `${i + 1}. "${c.title}" by ${c.channel} (觀看次數: ${((c.viewCount || 0) / 10000).toFixed(1)}萬)`
    ).join('\n');
    const historyContext = historyTitles.slice(-8).join('、') || '無';

    const prompt = `你是一個專業的音樂 DJ 助理。請注意：我們**只允許推薦音樂、歌曲、或官方 MV**！
嚴格禁止推薦任何新聞報導、政論節目、談話節目、Podcast、生活 VLOG、直播剪輯或非音樂類型的影片（例如包含「新聞」、「LIVE大現場」、「直播」、「政論」、「政論節目」等字眼的候選影片一律不能推薦）。

請幫我從以下候選名單中，篩選並挑選出最適合接在「${currentSongTitle || '目前播放歌曲'}」後面播放的 5 首**音樂/歌曲/MV**，並用一句話說明推薦理由（中文，15字以內）。

最近播過的歌曲（請避免重複）：${historyContext}

候選影片名單：
${candidateList}

請只回傳 JSON 格式，範例：
[{"index":1,"reason":"節奏相近，適合延續情緒"},{"index":3,"reason":"同系列風格，自然銜接"}]
只輸出 JSON array，不要其他文字。`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 512 }
        })
      }
    );

    // 如果遇到 429 (Too Many Requests)，嘗試等待後重試一次 (最多重試 3 次)
    if (geminiRes.status === 429) {
      if (retryCount >= 3) {
        console.warn('[Gemini] Rate limit hit too many times (429). Falling back to default sorting.');
        return candidates.map(c => ({ ...c, reason: '為您智能推薦', aiPicked: false }));
      }
      console.warn(`[Gemini] Rate limit hit (429). Retrying in 2 seconds... (Attempt ${retryCount + 1}/3)`);
      await new Promise(r => setTimeout(r, 2000));
      return rankWithGemini(currentSongTitle, candidates, historyTitles, retryCount + 1);
    }

    if (!geminiRes.ok) {
      console.warn('[Gemini] API error:', geminiRes.status);
      return candidates.map(c => ({ ...c, reason: '為您智能推薦', aiPicked: false }));
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonText = rawText.replace(/```json?/gi, '').replace(/```/g, '').trim();
    const ranked = JSON.parse(jsonText);

    const result = [];
    for (const r of ranked) {
      const idx = r.index - 1;
      if (idx >= 0 && idx < candidates.length) {
        result.push({ ...candidates[idx], reason: r.reason || '為您智能推薦', aiPicked: true });
      }
    }
    // 補足到 8 首
    for (const c of candidates) {
      if (result.length >= 8) break;
      if (!result.find(r => r.videoId === c.videoId)) {
        result.push({ ...c, reason: '相關推薦', aiPicked: false });
      }
    }
    console.log(`[Gemini] Ranked ${result.length} songs for "${currentSongTitle}"`);
    return result;
  } catch (e) {
    console.error('rankWithGemini error:', e);
    return candidates.map(c => ({ ...c, reason: '為您智能推薦', aiPicked: false }));
  }
}

// 供伺服器端自己搜尋 YouTube 使用的 helper
// 返回多個結果供比對，或是返回單一結果
async function searchYouTubeServerSide(query, enforceOfficial = true, multi = false) {
  if (Date.now() < ytQuotaExceededUntil) return multi ? [] : null;
  try {
    const currentKey = getCurrentYTKey();
    const exactQuery = enforceOfficial ? query + " Official Music Video" : query;
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=10&q=${encodeURIComponent(exactQuery)}&key=${currentKey}`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();
    
    if (searchData.error && searchData.error.message.includes('quota')) {
      if (rotateYTKey()) {
        return searchYouTubeServerSide(query, enforceOfficial, multi);
      }
      
      // 所有 Key 都爆了，使用 yt-search 終極備援
      console.log(`[ServerSearch Fallback] Using yt-search for: ${query}`);
      try {
        const r = await yts(query);
        const videos = r.videos.slice(0, multi ? 10 : 1).map(v => ({
          videoId: v.videoId,
          title: v.title,
          channel: v.author.name,
          thumbnail: v.thumbnail,
          viewCount: v.views ? v.views.toString() : '0',
          publishedAt: v.ago || ''
        }));
        return multi ? videos : (videos[0] || null);
      } catch (e) {
        console.error('yt-search fallback error:', e);
      }
      return multi ? [] : null;
    }

    if (!searchData.items || searchData.items.length === 0) return multi ? [] : null;

    const videoIds = searchData.items.map(it => it.id.videoId).join(',');
    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoIds}&key=${currentKey}`;
    const videosRes = await fetch(videosUrl);
    const videosData = await videosRes.json();

    if (!videosData.items) return multi ? [] : null;

    const results = [];
    // 找沒有年齡限制的影片
    for (const it of videosData.items) {
      const rating = it.contentDetails && it.contentDetails.contentRating;
      if (!(rating && rating.ytRating === 'ytAgeRestricted')) {
        results.push({
          videoId: it.id,
          title: it.snippet.title,
          channel: it.snippet.channelTitle,
          thumbnail: it.snippet.thumbnails && (it.snippet.thumbnails.medium || it.snippet.thumbnails.default).url,
          durationSec: parseISO8601Duration(it.contentDetails.duration || 'PT0S')
        });
      }
    }
    return multi ? results : (results[0] || null);
  } catch (e) {
    console.error("searchYouTubeServerSide error:", e);
  }
  return multi ? [] : null;
}

// ================================================================
// 給前端用的 AI 推薦 API (模擬 YouTube 右側推薦欄)
// ================================================================
const recommendCache = {}; // { room: { videoId, results, timestamp } }

app.get('/api/recommendations', async (req, res) => {
  const room = getRoom(req);
  const currentVideoId = req.query.videoId || null;
  try {
    // 快取：同一首歌 3 分鐘內不重複呼叫 API
    const cache = recommendCache[room];
    if (cache && cache.videoId === currentVideoId && Date.now() - cache.timestamp < 3 * 60 * 1000) {
      return res.json(cache.results);
    }

    const history = await readHistory(room);
    const queue = await readQueue(room);
    const historyTitles = [...history, ...queue].map(h => h.title || '').filter(Boolean);
    const historyIds = new Set([...history, ...queue].map(h => extractVideoId(h.url || '')).filter(Boolean));

    let candidates = [];
    const currentItem = queue[0] || (history.length > 0 ? history[history.length - 1] : null);
    const seedTitle = currentItem ? currentItem.title : null;

    // Step 1: 發現相關影片 (搜尋發現模式)
    if (seedTitle) {
      console.log(`[AI Rec] Discovering for: ${seedTitle}`);
      candidates = await fetchRelatedVideos(seedTitle, 15);
    }

    // Step 2: 若不夠，補充歷史種子
    if (candidates.length < 5) {
      const historySeedItem = history[Math.floor(Math.random() * history.length)];
      if (historySeedItem && historySeedItem.title && historySeedItem.title !== seedTitle) {
        console.log(`[AI Rec] Using history seed title: ${historySeedItem.title}`);
        const extra = await fetchRelatedVideos(historySeedItem.title, 10);
        candidates = [...candidates, ...extra];
      }
    }

    // Step 3: 過濾已播放/時長過長/非官方/重複歌名影片
    const filtered = [];
    const seenTitles = new Set();
    
    for (const c of candidates) {
      const vId = c.videoId || extractVideoId(c.url || '');
      if (historyIds.has(vId)) continue;
      if ((c.durationSec || 0) > 600) continue;
      
      // 檢查是否為官方 MV
      if (!isOfficialMV(c.title, c.channel)) continue;
      
      // 檢查是否與 queue/history 中的歌重複
      if (isDuplicateTitle(c.title, historyTitles)) continue;
      
      // 檢查是否在本次推薦名單中重複
      const norm = normalizeTitle(c.title);
      if (seenTitles.has(norm)) continue;
      seenTitles.add(norm);
      
      filtered.push(c);
    }

    // Step 4: Gemini 智能排序 + 生成推薦理由
    const ranked = await rankWithGemini(seedTitle || '目前播放', filtered, historyTitles);
    const finalResults = ranked.slice(0, 8);
    
    // 自動將發現的歌曲存入本地庫存
    await saveToLocalDatabase(room, finalResults);

    recommendCache[room] = { videoId: currentVideoId, results: finalResults, timestamp: Date.now() };
    console.log(`[AI Rec] Returning ${finalResults.length} items for room ${room}`);
    res.json(finalResults);
  } catch (e) {
    console.error('/api/recommendations error:', e);
    res.json([]);
  }
});

// 自動加入推薦歌曲 (升級版：改用搜尋發現 + Gemini 排序)
const lastRecommendationTime = new Map(); // { room: timestamp }

async function autoAddSong(room, q) {
  // 檢查冷卻時間 (30 秒)，避免頻繁呼叫 Gemini API
  const now = Date.now();
  const lastTime = lastRecommendationTime.get(room) || 0;
  if (now - lastTime < 30 * 1000) {
    return;
  }

  if (recommendingRooms.has(room)) {
    console.log(`[AI DJ] Recommendation already in progress for room ${room}. Skipping.`);
    return;
  }
  recommendingRooms.add(room);
  lastRecommendationTime.set(room, now);

  try {
    const history = await readHistory(room);
    const historyIds = history.map(h => extractVideoId(h.url || '')).filter(Boolean);
    const queueIds = q.map(item => extractVideoId(item.url || '')).filter(Boolean);
    const allBlockedIds = new Set([...historyIds, ...queueIds]);
    const historyTitles = [...history, ...q].map(h => h.title || '').filter(Boolean);

    const seenTitles = new Set();
    const isValid = (r) => {
      if (!r || !r.videoId) return false;
      if (allBlockedIds.has(r.videoId)) return false;
      
      // 檢查是否為官方 MV
      if (!isOfficialMV(r.title, r.channel)) return false;
      
      // 檢查是否與 queue/history 中的歌重複
      if (isDuplicateTitle(r.title, historyTitles)) return false;
      
      // 檢查是否在本次處理中重複
      const norm = normalizeTitle(r.title);
      if (seenTitles.has(norm)) return false;
      seenTitles.add(norm);
      
      if ((r.durationSec || 0) > 600) return false;
      return true;
    };

    let candidates = [];
    const currentItem = q[0] || history[history.length - 1];
    const seedTitle = currentItem ? currentItem.title : null;

    // 策略 1: 用目前播放歌曲標題進行相關搜尋
    if (seedTitle) {
      console.log(`[AI DJ] Discovering content similar to: ${seedTitle}`);
      candidates = await fetchRelatedVideos(seedTitle, 15);
    }

    // 策略 2: 從歷史隨機選一首標題作為搜尋種子
    if (candidates.filter(isValid).length < 5) {
      const historySeedItem = history[Math.floor(Math.random() * history.length)];
      if (historySeedItem && historySeedItem.title && historySeedItem.title !== seedTitle) {
        console.log(`[AI DJ] Using history seed title: ${historySeedItem.title}`);
        const extra = await fetchRelatedVideos(historySeedItem.title, 10);
        candidates = [...candidates, ...extra];
      }
    }

    // 策略 3: 若完全沒有種子 (新房間)，使用熱門關鍵字作為起始
    let validCandidates = candidates.filter(isValid);
    if (validCandidates.length === 0) {
      console.log(`[AI DJ] No seed found or invalid seed. Using trending fallback.`);
      const trends = ["2025 熱門歌曲 Official MV", "華語流行音樂 2025", "Billboard Top Hits 2025"];
      const randomTrend = trends[Math.floor(Math.random() * trends.length)];
      const searchResults = await searchYouTubeServerSide(randomTrend, true, true);
      candidates = searchResults || [];
      validCandidates = candidates.filter(isValid);
    }

    if (validCandidates.length === 0) {
      console.log(`[AI DJ] YouTube API unavailable (Quota/Error). Using local history fallback.`);
      const allSongs = await readSongs(room);
      const songPool = Object.values(allSongs).filter(s => !allBlockedIds.has(extractVideoId(s.url || '')));
      
      // 隨機挑選 8 首
      const fallbackResults = songPool.sort(() => 0.5 - Math.random()).slice(0, 8);
      for (const s of fallbackResults) {
        q.push({
          url: s.url,
          title: s.title,
          channel: s.channel || '本地收藏',
          thumbnail: s.thumbnail,
          requester: { name: '系統' },
          reason: '根據您的聽歌歷史推薦',
          aiPicked: false,
          votes: 0,
          votedIds: []
        });
      }
      await writeQueue(room, q);
      console.log(`[AI DJ] Auto-queued ${fallbackResults.length} local songs.`);
      return;
    }

    // 使用 Gemini 智能排序並產生推薦理由
    const currentSongTitle = currentItem ? currentItem.title : '';
    const ranked = await rankWithGemini(currentSongTitle || '熱門推薦', validCandidates, historyTitles);
    
    // 取前 8 首
    const finalResults = ranked.slice(0, 8);

    // 自動將 AI 發現的歌曲存入本地資料庫
    await saveToLocalDatabase(room, finalResults);

    for (const res of finalResults) {
      q.push({
        url: 'https://www.youtube.com/watch?v=' + res.videoId,
        title: res.title,
        channel: res.channel,
        thumbnail: res.thumbnail,
        requester: { name: '系統' },
        reason: res.reason,
        aiPicked: res.aiPicked,
        votes: 0,
        votedIds: []
      });
    }

    await writeQueue(room, q);
    console.log(`[AI DJ] Auto-queued ${finalResults.length} AI recommendations.`);
  } catch (e) {
    console.error('Auto queue error:', e);
  } finally {
    recommendingRooms.delete(room);
  }
}

// 跳轉至指定歌曲 (插播)
app.post('/api/jump', async (req, res) => {
  const room = getRoom(req);
  const { index } = req.body;
  const q = await readQueue(room);
  
  if (index > 0 && index < q.length) {
    const target = q.splice(index, 1)[0];
    // 將跳轉的歌曲移到 index 0 (正在播放)，原本正在播放的歌曲會被替換 (或是您可以選擇保留它，但這裡我們遵循"切歌"邏輯)
    q.shift();
    q.unshift(target);
    await writeQueue(room, q);
    
    // 通知所有客戶端立即更新 (這會觸發播放器的 checkNext)
    if (typeof io !== 'undefined') {
      io.to(room).emit('refresh');
    }
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Invalid index' });
});

// Get next (first) item
app.get('/next', async (req, res) => {
  const room = getRoom(req);
  const q = await readQueue(room);
  const settings = await getSettings(room);
  
  const userSongsCount = q.filter(it => !it.requester || it.requester.name !== '系統').length;
  // 如果沒有真實使用者的點歌，且佇列即將見底，則補充推薦歌曲
  if (settings.autoQueue && userSongsCount === 0 && q.length <= 2) {
    await autoAddSong(room, q);
  }
  res.json(q.length ? q[0] : { url: null, title: null, channel: null, thumbnail: null });
});

// Finish (pop first)
app.post('/finish', async (req, res) => {
  const room = getRoom(req);
  const q = await readQueue(room);
  if (q.length) {
    await pushToHistory(room, q[0]);
    q.shift();
  }
  await writeQueue(room, q);
  res.json({ ok: true });
});

// 檢查投票是否過期 (Helper)
async function checkVoteExpiry(room, q) {
  const settings = await getSettings(room);
  if (q.length > 0) {
    const item = q[0];
    if (item.votes && item.voteStartTime) {
      const elapsed = Date.now() - item.voteStartTime;
      if (elapsed > settings.timeout) {
        // 過期重置
        item.votes = 0;
        item.votedIds = [];
        delete item.voteStartTime;
        await writeQueue(room, q);
      }
    }
  }
}

// 投票切歌 API
app.post('/vote-skip', async (req, res) => {
  const room = getRoom(req);
  const q = await readQueue(room);
  if (q.length === 0) return res.status(400).json({ error: "目前沒有歌曲" });

  // 檢查是否過期
  await checkVoteExpiry(room, q);

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
  const users = await readUsers(room);
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

  const settings = await getSettings(room);
  if (item.votes >= settings.threshold) {
    // 執行停權 (5分鐘)
    if (item.requester && item.requester.id) {
      const users = await readUsers(room);
      if (!users[item.requester.id]) users[item.requester.id] = {};
      users[item.requester.id].bannedUntil = Date.now() + settings.banDuration;
      await writeUsers(room, users);
    }

    // 設定切歌訊息供前端顯示
    lastSkipMessages[room] = {
      type: 'vote',
      title: item.title,
      requester: item.requester ? item.requester.name : '未知',
      banDuration: Math.ceil(settings.banDuration / 60000),
      timestamp: Date.now()
    };

    await pushToHistory(room, q[0]);
    q.shift(); // 移除目前歌曲
    await writeQueue(room, q);
    return res.json({ ok: true, message: "票數已達，切歌！", skipped: true });
  }

  await writeQueue(room, q);
  res.json({ ok: true, message: "投票成功", votes: item.votes });
});

// Get full queue
app.get('/queue', async (req, res) => {
  const room = getRoom(req);
  const q = await readQueue(room);
  await checkVoteExpiry(room, q); // 讀取時順便檢查過期

  const settings = await getSettings(room);
  const userSongsCount = q.filter(it => !it.requester || it.requester.name !== '系統').length;
  
  // 非同步補充 AI 推薦歌曲 (Pre-fetch)，確保播放無縫接軌
  if (settings.autoQueue && userSongsCount === 0 && q.length > 0 && q.length <= 2) {
    if (!recommendingRooms.has(room)) {
      // 在背景執行，不阻塞當前請求
      autoAddSong(room, q).catch(console.error);
    }
  }

  res.json(q);
});

// 排行榜 API
app.get('/leaderboard', async (req, res) => {
  const room = getRoom(req);
  const users = await readUsers(room);
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
  const room = getRoom(req);
  const songs = await readSongs(room);
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
  const room = getRoom(req);
  const idx = parseInt(req.params.index);
  const q = await readQueue(room);
  if (!isNaN(idx) && idx >= 0 && idx < q.length) {
    q.splice(idx, 1);
    await writeQueue(room, q);
  }
  res.json({ ok: true });
});

// Withdraw own song (for users)
app.post('/api/queue/withdraw/:index', async (req, res) => {
  const room = getRoom(req);
  const idx = parseInt(req.params.index);
  const { userId } = req.body;

  if (!userId) return res.status(400).json({ error: "No user ID provided" });

  const q = await readQueue(room);
  if (!isNaN(idx) && idx > 0 && idx < q.length) {
    // Cannot withdraw the currently playing song (idx = 0)
    const item = q[idx];
    if (item.requester && item.requester.id === userId) {
      q.splice(idx, 1);
      await writeQueue(room, q);
      return res.json({ ok: true, message: "已撤回您的歌曲" });
    } else {
      return res.status(403).json({ error: "您只能撤回自己點播的歌曲" });
    }
  }
  res.status(400).json({ error: "無效的歌曲或無法撤回正在播放的歌曲" });
});

app.get('/playlist', async (req, res) => {
  const room = getRoom(req);
  const list = await readData('playlist', room, []);
  res.json(list);
});

app.post('/playlist/save', async (req, res) => {
  try {
    const room = getRoom(req);
    const q = await readQueue(room);
    await writeData('playlist', room, q);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "save playlist error" });
  }
});

app.post('/playlist/load', async (req, res) => {
  try {
    const room = getRoom(req);
    const playlist = await readData('playlist', room, []);
    if (!playlist || playlist.length === 0) return res.json({ ok: false });

    await writeQueue(room, playlist);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "load playlist error" });
  }
});

app.post('/playlist/clear', async (req, res) => {
  try {
    const room = getRoom(req);
    await writeData('playlist', room, []);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "clear playlist error" });
  }
});

// 取得設定 (公開)
app.get('/settings', async (req, res) => {
  const room = getRoom(req);
  const settings = await getSettings(room);
  res.json({
    threshold: settings.threshold,
    timeout: settings.timeout,
    banDuration: settings.banDuration / 60000,
    autoQueue: settings.autoQueue,
    volume: settings.volume !== undefined ? settings.volume : 100,
    readAloud: settings.readAloud || false,
    strictMusicOnly: settings.strictMusicOnly
  });
});

// 修改門檻 (管理員)
app.post('/admin/threshold', protect, async (req, res) => {
  const room = getRoom(req);
  const val = parseInt(req.body.threshold);
  if (val && val > 0) {
    await saveSettings(room, { threshold: val });
    const s = await getSettings(room);
    res.json({ ok: true, threshold: s.threshold });
  } else {
    res.status(400).json({ error: "無效的數值" });
  }
});

// 修改停權時間 (管理員)
app.post('/admin/ban-duration', protect, async (req, res) => {
  const room = getRoom(req);
  const val = parseInt(req.body.banDuration);
  if (val && val > 0) {
    await saveSettings(room, { banDuration: val * 60 * 1000 });
    res.json({ ok: true, banDuration: val });
  } else {
    res.status(400).json({ error: "無效的數值" });
  }
});

// 修改自動推薦開關 (管理員)
app.post('/admin/auto-queue', protect, async (req, res) => {
  const room = getRoom(req);
  const { enabled } = req.body;
  if (typeof enabled === 'boolean') {
    await saveSettings(room, { autoQueue: enabled });
    res.json({ ok: true, autoQueue: enabled });
  } else {
    res.status(400).json({ error: "Invalid value" });
  }
});

// 修改音量 (管理員)
app.post('/admin/volume', protect, async (req, res) => {
  const room = getRoom(req);
  const val = parseInt(req.body.volume);
  if (!isNaN(val) && val >= 0 && val <= 100) {
    await saveSettings(room, { volume: val });
    res.json({ ok: true, volume: val });
  } else {
    res.status(400).json({ error: "Invalid value" });
  }
});

// 修改朗讀彈幕開關 (管理員)
app.post('/admin/read-aloud', protect, async (req, res) => {
  const room = getRoom(req);
  const { enabled } = req.body;
  if (typeof enabled === 'boolean') {
    await saveSettings(room, { readAloud: enabled });
    res.json({ ok: true, readAloud: enabled });
  } else {
    res.status(400).json({ error: "Invalid value" });
  }
});

// 修改嚴格音樂模式 (管理員)
app.post('/admin/strict-music', protect, async (req, res) => {
  const room = getRoom(req);
  const { enabled } = req.body;
  if (typeof enabled === 'boolean') {
    await saveSettings(room, { strictMusicOnly: enabled });
    res.json({ ok: true, strictMusicOnly: enabled });
  } else {
    res.status(400).json({ error: "Invalid value" });
  }
});

// 更改順序 (管理員)
app.post('/admin/reorder', protect, async (req, res) => {
  const room = getRoom(req);
  const { oldIndex, newIndex } = req.body;
  const q = await readQueue(room);
  if (
    typeof oldIndex === 'number' && oldIndex >= 0 && oldIndex < q.length &&
    typeof newIndex === 'number' && newIndex >= 0 && newIndex < q.length
  ) {
    const [item] = q.splice(oldIndex, 1);
    q.splice(newIndex, 0, item);
    await writeQueue(room, q);
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: "無效的索引" });
  }
});

// 管理員強制切歌 (帶原因與圖片)
app.post('/admin/skip', protect, async (req, res) => {
  const room = getRoom(req);
  const { reason, image } = req.body;
  const q = await readQueue(room);
  const settings = await getSettings(room);

  // 執行切歌邏輯
  let skippedItem = null;
  if (q.length > 0) {
    skippedItem = q[0];
    await pushToHistory(room, skippedItem);
    q.shift();
    await writeQueue(room, q);

    // 執行停權 (5分鐘)
    if (skippedItem.requester && skippedItem.requester.id) {
      const users = await readUsers(room);
      if (!users[skippedItem.requester.id]) users[skippedItem.requester.id] = {};
      users[skippedItem.requester.id].bannedUntil = Date.now() + settings.banDuration;
      await writeUsers(room, users);
    }
  }

  // 紀錄訊息供前端顯示
  lastSkipMessages[room] = {
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
  const room = getRoom(req);
  const users = await readUsers(room);
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
  const room = getRoom(req);
  const { userId } = req.body;
  const users = await readUsers(room);

  if (users[userId]) {
    delete users[userId].bannedUntil;
    await writeUsers(room, users);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "找不到使用者" });
  }
});

// --- 違禁詞管理 API ---
app.get('/admin/banned-words', protect, async (req, res) => {
  const room = getRoom(req);
  const words = await readBannedWords(room);
  res.json(words);
});

app.post('/admin/banned-words/add', protect, async (req, res) => {
  const room = getRoom(req);
  const { word } = req.body;
  if (!word || !word.trim()) return res.status(400).json({ error: "請輸入違禁詞" });

  const words = await readBannedWords(room);
  if (!words.includes(word)) {
    words.push(word);
    await writeBannedWords(room, words);
  }
  res.json({ ok: true });
});

app.post('/admin/banned-words/remove', protect, async (req, res) => {
  const room = getRoom(req);
  const { word } = req.body;
  const words = await readBannedWords(room);
  const newWords = words.filter(w => w !== word);
  await writeBannedWords(room, newWords);
  res.json({ ok: true });
});


// 取得最新的切歌訊息
app.get('/skip-message', (req, res) => {
  const room = getRoom(req);
  res.json(lastSkipMessages[room] || {});
});

// --- 公告跑馬燈 API ---
app.post('/admin/marquee', protect, async (req, res) => {
  const room = getRoom(req);
  const { text } = req.body;
  // 若 text 為空字串則代表清除
  marquees[room] = { text: text || "", timestamp: Date.now() };
  res.json({ ok: true });
});

app.get('/marquee', (req, res) => {
  const room = getRoom(req);
  res.json(marquees[room] || { text: "" });
});

// --- 彈幕 API ---
app.post('/danmaku', async (req, res) => {
  const room = getRoom(req);
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
    if (!danmakuLists[room]) danmakuLists[room] = [];
    danmakuLists[room].push(msg);
  }

  // 保留最近 100 則，避免記憶體膨脹
  if (danmakuLists[room].length > 100) {
    danmakuLists[room] = danmakuLists[room].slice(-100);
  }

  res.json({ ok: true });
});

app.get('/danmaku', (req, res) => {
  const room = getRoom(req);
  const since = parseInt(req.query.since) || 0;
  // 回傳比 since 新的訊息
  const list = danmakuLists[room] || [];
  const newMsgs = list.filter(m => m.timestamp > since);
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

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

  // --- 防止 Render 休眠 (Self-Ping) ---
  // 請在 Render 後台設定環境變數 RENDER_EXTERNAL_URL = 你的網站網址 (例如 https://xxx.onrender.com)
  if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => {
      fetch(`${process.env.RENDER_EXTERNAL_URL}/health`)
        .then(() => console.log('Keep-alive ping success'))
        .catch(e => console.error('Keep-alive ping failed', e));
    }, 14 * 60 * 1000); // 每 14 分鐘發送一次請求
  }
}

module.exports = app;
