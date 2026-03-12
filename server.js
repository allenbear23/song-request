// server.js
const express = require('express');
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
// ------------------------------------------------

const USERS_FILE = 'users.json'; // 使用者統計資料檔
const BANNED_WORDS_FILE = 'banned_words.json'; // 違禁詞資料檔
const SONGS_FILE = 'songs.json'; // 歌曲統計資料檔
const ADMIN_ROOMS_FILE = 'admin_rooms.json'; // 管理員與房間對應檔

// 預設設定
const DEFAULT_SETTINGS = {
  threshold: 3, timeout: 60000, banDuration: 5 * 60 * 1000,
  autoQueue: true, volume: 100, readAloud: false
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
  else if (key === 'bannedWords') fileName = isDefault ? BANNED_WORDS_FILE : `banned_words_${room}.json`;
  else if (key === 'songs') fileName = isDefault ? SONGS_FILE : `songs_${room}.json`;
  else if (key === 'settings') fileName = isDefault ? 'settings.json' : `settings_${room}.json`;
  else return;

  try {
    await fs.promises.writeFile(fileName, JSON.stringify(data, null, 2));
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

// Fetch full video info: title, channel, thumbnail
async function fetchVideoInfo(videoId) {
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${YT_API_KEY}`);
    const data = await res.json();
    if (data && data.items && data.items.length > 0) {
      const item = data.items[0];
      const snip = item.snippet;

      // 檢查年齡限制
      const rating = item.contentDetails && item.contentDetails.contentRating;
      if (rating && rating.ytRating === 'ytAgeRestricted') {
        return { error: '此影片設有年齡限制，無法在背景播放器中播放' };
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

  // 本地測試 Bypass 機制 (為了無 API Key 時能測試 UI)
  if (req.query.bypassLogin === '1') {
    return res.json([
      {
        videoId: "MVD7fhKgGzc",
        title: "周杰倫最好聽的20首歌曲 | 在雨天聽周杰倫－絕佳的選擇 | Listening to Jay Chou on a rainy day - An excellent choice",
        channel: "杰威爾歌詞MV頻道JVR Lyric MV",
        thumbnail: "https://i.ytimg.com/vi/MVD7fhKgGzc/hqdefault.jpg",
        viewCount: "35400000",
        publishedAt: "2018-05-15T00:00:00Z"
      },
      {
        videoId: "dQw4w9WgXcQ",
        title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
        channel: "Rick Astley",
        thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        viewCount: "1350000000",
        publishedAt: "2009-10-25T00:00:00Z"
      },
      {
        videoId: "HmFhhfF68OU",
        title: "劉大壯 - 最【動態歌詞】「最最最 難忘回憶是與你 最最最 最後一吻的距離」♪",
        channel: "Angelic Music World",
        thumbnail: "https://i.ytimg.com/vi/HmFhhfF68OU/hqdefault.jpg",
        viewCount: "8500",
        publishedAt: "2023-11-20T00:00:00Z"
      }
    ]);
  }

  try {
    // 1. 先用 search API 取得影片清單
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(q)}&key=${YT_API_KEY}`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (!searchData.items || searchData.items.length === 0) return res.json([]);

    // 2. 收集所有 videoId，再呼叫 videos API 取得統計資料 (包含觀看次數 snippet 包含發布時間)
    const videoIds = searchData.items.map(it => it.id.videoId).join(',');
    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoIds}&key=${YT_API_KEY}`;
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

    // 驗證 token 是否送來
    if (!token) {
      return res.status(400).json({ error: 'reCAPTCHA token missing' });
    }

    // 檢查使用者是否被停權
    if (user && user.userId) {
      const users = await readUsers(room);
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

    // 檢查是否為本地測試員 (Bypass Login)
    const isLocalTest = user && user.displayName === '本地測試員';

    // verifyJson 範例: { success: true, score: 0.9, action: "submit", ... }
    if (!isLocalTest && (!verifyJson.success || (verifyJson.score !== undefined && verifyJson.score < 0.5))) {
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

    const queue = await readQueue(room);
    const already = queue.some(item => extractVideoId(item.url) === videoId);
    if (already) {
      return res.status(400).json({ error: '此歌曲已在排隊中，請選擇其他歌曲' });
    }

    const info = await fetchVideoInfo(videoId);
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
    const songs = await readSongs(room);
    if (!songs[videoId]) songs[videoId] = { count: 0 };
    songs[videoId].title = info.title;
    songs[videoId].thumbnail = info.thumbnail;
    songs[videoId].count = (songs[videoId].count || 0) + 1;
    await writeSongs(room, songs);

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
      "https://api-inference.huggingface.co/models/unitary/multilingual-toxic-xlm-roberta",
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
      console.warn('Hugging Face API returned status:', response.status);
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

// 生成 AI 推薦的 YouTube 搜尋字串
async function generateAISongQuery(room) {
  const hfApiKey = process.env.HF_API_KEY;
  const defaultQueries = ["周杰倫 最新", "告五人", "華語 流行 推薦", "Billboard Hot 100", "KPOP Hit"];

  if (!hfApiKey) {
    return defaultQueries[Math.floor(Math.random() * defaultQueries.length)];
  }

  try {
    const songs = await readSongs(room);
    const recentSongs = Object.values(songs)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(s => s.title)
      .join(', ');

    // 取得歷史播放或是目前在佇列的歌曲，避免 AI 重複點播
    const q = await readData('queue', room, []);
    const playlist = await readData('playlist', room, []);

    // 收集最近的 15 首歌名，避免過度重複
    const historyItems = [...playlist.slice(-10), ...q.slice(0, 5)];
    const historyTitles = historyItems.map(item => item.title || '').filter(Boolean).join(', ');

    const prompt = `You are a professional DJ. Based on these popular songs in this room: [${recentSongs}]. 
    Please suggest exactly ONE highly related but different song that the audience will love. 
    CRITICAL INSTRUCTION: You MUST NOT suggest any of these recently played songs: [${historyTitles}]. If you suggest a song from this list, you fail.
    Respond with ONLY the 'Song Name - Artist Name', without any quotes, numbering, or extra text.`;

    const response = await fetch(
      "https://api-inference.huggingface.co/models/Qwen/Qwen2.5-72B-Instruct",
      {
        headers: {
          Authorization: `Bearer ${hfApiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({
          inputs: prompt,
          parameters: { max_new_tokens: 30, return_full_text: false, temperature: 0.95 }
        }),
      }
    );

    if (!response.ok) throw new Error(`HF API Error: ${response.status}`);
    const result = await response.json();

    if (Array.isArray(result) && result[0] && result[0].generated_text) {
      const query = result[0].generated_text.trim();
      return query || defaultQueries[Math.floor(Math.random() * defaultQueries.length)];
    }
  } catch (e) {
    console.error('generateAISongQuery error:', e);
  }
  return defaultQueries[Math.floor(Math.random() * defaultQueries.length)];
}

// 供伺服器端自己搜尋 YouTube 使用的 helper
async function searchYouTubeServerSide(query) {
  try {
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(query)}&key=${YT_API_KEY}`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (!searchData.items || searchData.items.length === 0) return null;

    const videoIds = searchData.items.map(it => it.id.videoId).join(',');
    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoIds}&key=${YT_API_KEY}`;
    const videosRes = await fetch(videosUrl);
    const videosData = await videosRes.json();

    if (!videosData.items) return null;

    // 找第一首沒有年齡限制的影片
    for (const it of videosData.items) {
      const rating = it.contentDetails && it.contentDetails.contentRating;
      if (!(rating && rating.ytRating === 'ytAgeRestricted')) {
        return {
          videoId: it.id,
          title: it.snippet.title,
          channel: it.snippet.channelTitle,
          thumbnail: it.snippet.thumbnails && (it.snippet.thumbnails.medium || it.snippet.thumbnails.default).url,
        };
      }
    }
  } catch (e) {
    console.error("searchYouTubeServerSide error:", e);
  }
  return null;
}

// 自動加入推薦歌曲 (Helper)
async function autoAddSong(room, q) {
  try {
    const aiQuery = await generateAISongQuery(room);
    console.log(`AI suggested query: ${aiQuery}`);

    let ytResult = await searchYouTubeServerSide(aiQuery);

    // 如果找不到或是查出來是不當訊息，隨便抓熱門歌清單重試一次
    if (!ytResult || (await checkIfInappropriate(ytResult.title))) {
      console.log(`Initial AI fallback... trying default query.`);
      ytResult = await searchYouTubeServerSide("華語 流行 歌曲 熱門");
    }

    // 退無可退，從資料庫撈歷史歌曲
    if (!ytResult) {
      const songs = await readSongs(room);
      const ids = Object.keys(songs);
      if (ids.length === 0) return;
      const rId = ids[Math.floor(Math.random() * ids.length)];
      const s = songs[rId];
      ytResult = { videoId: rId, title: s.title, channel: "系統歷史推薦", thumbnail: s.thumbnail };
    }

    const newItem = {
      url: 'https://www.youtube.com/watch?v=' + ytResult.videoId,
      title: ytResult.title,
      channel: "系統自動推薦 (AI DJ)",
      thumbnail: ytResult.thumbnail,
      requester: { name: "系統" },
      votes: 0,
      votedIds: []
    };

    q.push(newItem);
    await writeQueue(room, q);
    console.log('Auto-queued by AI DJ:', ytResult.title);
  } catch (e) {
    console.error('Auto queue error:', e);
  }
}

// Get next (first) item
app.get('/next', async (req, res) => {
  const room = getRoom(req);
  const q = await readQueue(room);
  const settings = await getSettings(room);
  if (q.length === 0 && settings.autoQueue) {
    await autoAddSong(room, q);
  }
  res.json(q.length ? q[0] : { url: null, title: null, channel: null, thumbnail: null });
});

// Finish (pop first)
app.post('/finish', async (req, res) => {
  const room = getRoom(req);
  const q = await readQueue(room);
  if (q.length) q.shift();
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
    readAloud: settings.readAloud || false
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
    skippedItem = q.shift();
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
