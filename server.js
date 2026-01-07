// server.js
const ADMIN_USER = "allen";      // 你的帳號
const ADMIN_PASS = "123456";     // 你的密碼

const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // node-fetch@2
const app = express();
const PORT = process.env.PORT || 3000;

// ---------- 請把你的 API key 填在這裡 ----------
const YT_API_KEY = "AIzaSyBEa3LCMKLL8cBJW_l7TPlylbMyxNFDvD0";
// ------------------------------------------------

let VOTE_THRESHOLD = 3;       // 預設 3 票切歌
const VOTE_TIMEOUT = 60000;   // 投票有效時間 60 秒
let BAN_DURATION = 5 * 60 * 1000; // 預設停權 5 分鐘
const USERS_FILE = 'users.json'; // 使用者統計資料檔

app.use(express.json({ limit: '50mb' })); // 提高限制以支援圖片上傳
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
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

let lastSkipMessage = null; // 儲存最新的管理員切歌訊息

// helper: ensure requests.json exists (returns array)
function readQueue() {
  try {
    if (!fs.existsSync('requests.json')) return [];
    const raw = fs.readFileSync('requests.json', 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    console.error('readQueue error:', e);
    return [];
  }
}

function writeQueue(q) {
  try {
    fs.writeFileSync('requests.json', JSON.stringify(q, null, 2));
  } catch (e) {
    console.error('writeQueue error:', e);
  }
}

function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return {};
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    console.error('readUsers error:', e);
    return {};
  }
}

function writeUsers(data) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('writeUsers error:', e);
  }
}

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
// Request (add to queue) — accepts either full URL or videoId via url param
// server.js 內：在 /request 路由中，先做 reCAPTCHA 驗證
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET || '6LdVAxAsAAAAABzsj87WM7MJBBTwLyXZmDCF6zvw';

app.post('/request', async (req, res) => {
  try {
    const { url, token, user } = req.body;

    // 驗證 token 是否送來
    if (!token) {
      return res.status(400).json({ error: 'reCAPTCHA token missing' });
    }
    
    // 檢查使用者是否被停權
    if (user && user.userId) {
      const users = readUsers();
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
    if (!verifyJson.success) {
      console.warn('reCAPTCHA failed', verifyJson);
      return res.status(400).json({ error: 'reCAPTCHA 驗證失敗，請再試一次' });
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

    const queue = readQueue();
    const already = queue.some(item => extractVideoId(item.url) === videoId);
    if (already) {
      return res.status(400).json({ error: '此歌曲已在排隊中，請選擇其他歌曲' });
    }

    const info = await fetchVideoInfo(videoId);
    if (!info) return res.status(500).json({ error: 'Failed to fetch video info.' });

    const fullUrl = 'https://www.youtube.com/watch?v=' + videoId;
    
    // --- 記錄使用者點歌次數 ---
    if (user && user.userId) {
      const users = readUsers();
      if (!users[user.userId]) users[user.userId] = { count: 0 };
      
      users[user.userId].name = user.displayName; // 更新最新暱稱
      users[user.userId].picture = user.pictureUrl; // 更新最新頭貼
      users[user.userId].count = (users[user.userId].count || 0) + 1;
      writeUsers(users);
    }
    
    queue.push({ 
      url: fullUrl, 
      title: info.title, 
      channel: info.channel, 
      thumbnail: info.thumbnail,
      requester: user ? { id: user.userId, name: user.displayName } : null
    });
    writeQueue(queue);

    console.log('Added to queue:', info.title);
    return res.json({ ok: true, title: info.title });

  } catch (e) {
    console.error('/request error:', e);
    return res.status(500).json({ error: 'Server error: ' + e.message });
  }
});



// Get next (first) item
app.get('/next', (req, res) => {
  const q = readQueue();
  res.json(q.length ? q[0] : { url: null, title: null, channel: null, thumbnail: null });
});

// Finish (pop first)
app.post('/finish', (req, res) => {
  const q = readQueue();
  if (q.length) q.shift();
  writeQueue(q);
  res.json({ ok: true });
});

// 檢查投票是否過期 (Helper)
function checkVoteExpiry(q) {
  if (q.length > 0) {
    const item = q[0];
    if (item.votes && item.voteStartTime) {
      const elapsed = Date.now() - item.voteStartTime;
      if (elapsed > VOTE_TIMEOUT) {
        // 過期重置
        item.votes = 0;
        item.votedIds = [];
        delete item.voteStartTime;
        writeQueue(q);
      }
    }
  }
}

// 投票切歌 API
app.post('/vote-skip', (req, res) => {
  const q = readQueue();
  if (q.length === 0) return res.status(400).json({ error: "目前沒有歌曲" });

  // 檢查是否過期
  checkVoteExpiry(q);

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

  if (item.votedIds.includes(voterId)) {
    return res.status(400).json({ error: "您已經投過票了" });
  }

  // 第一次投票設定開始時間
  if (item.votes === 0) item.voteStartTime = Date.now();

  item.votedIds.push(voterId);
  item.votes = (item.votes || 0) + 1;

  if (item.votes >= VOTE_THRESHOLD) {
    // 執行停權 (5分鐘)
    if (item.requester && item.requester.id) {
      const users = readUsers();
      if (!users[item.requester.id]) users[item.requester.id] = {};
      users[item.requester.id].bannedUntil = Date.now() + BAN_DURATION;
      writeUsers(users);
    }

    // 設定切歌訊息供前端顯示
    lastSkipMessage = {
      type: 'vote',
      title: item.title,
      requester: item.requester ? item.requester.name : '未知',
      banDuration: Math.ceil(BAN_DURATION / 60000),
      timestamp: Date.now()
    };

    q.shift(); // 移除目前歌曲
    writeQueue(q);
    return res.json({ ok: true, message: "票數已達，切歌！", skipped: true });
  }

  writeQueue(q);
  res.json({ ok: true, message: "投票成功", votes: item.votes });
});

// Get full queue
app.get('/queue', (req, res) => {
  const q = readQueue();
  checkVoteExpiry(q); // 讀取時順便檢查過期
  res.json(q);
});

// 排行榜 API
app.get('/leaderboard', (req, res) => {
  const users = readUsers();
  // 轉為陣列並排序
  const list = Object.values(users).map(u => ({
    name: u.name,
    picture: u.picture,
    count: u.count
  }));
  list.sort((a, b) => b.count - a.count); // 由大到小排序
  res.json(list.slice(0, 20)); // 只回傳前 20 名
});

// Delete by index
app.post('/delete/:index', (req, res) => {
  const idx = parseInt(req.params.index);
  const q = readQueue();
  if (!isNaN(idx) && idx >= 0 && idx < q.length) {
    q.splice(idx, 1);
    writeQueue(q);
  }
  res.json({ ok: true });
});
app.get('/playlist', (req, res) => {
  try {
    if (!fs.existsSync('playlist.json')) return res.json([]);
    const raw = fs.readFileSync('playlist.json', 'utf8') || '[]';
    res.json(JSON.parse(raw));
  } catch (err) {
    res.status(500).json({ error: "read playlist error" });
  }
});
app.post('/playlist/save', (req, res) => {
  try {
    const q = readQueue();
    fs.writeFileSync('playlist.json', JSON.stringify(q, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "save playlist error" });
  }
});
app.post('/playlist/load', (req, res) => {
  try {
    if (!fs.existsSync('playlist.json')) return res.json({ ok: false });

    const playlist = JSON.parse(fs.readFileSync('playlist.json'));
    writeQueue(playlist);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "load playlist error" });
  }
});
app.post('/playlist/clear', (req, res) => {
  try {
    fs.writeFileSync('playlist.json', '[]');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "clear playlist error" });
  }
});

// 取得設定 (公開)
app.get('/settings', (req, res) => {
  res.json({ threshold: VOTE_THRESHOLD, timeout: VOTE_TIMEOUT, banDuration: BAN_DURATION / 60000 });
});

// 修改門檻 (管理員)
app.post('/admin/threshold', protect, (req, res) => {
  const val = parseInt(req.body.threshold);
  if (val && val > 0) {
    VOTE_THRESHOLD = val;
    res.json({ ok: true, threshold: VOTE_THRESHOLD });
  } else {
    res.status(400).json({ error: "無效的數值" });
  }
});

// 修改停權時間 (管理員)
app.post('/admin/ban-duration', protect, (req, res) => {
  const val = parseInt(req.body.banDuration);
  if (val && val > 0) {
    BAN_DURATION = val * 60 * 1000;
    res.json({ ok: true, banDuration: val });
  } else {
    res.status(400).json({ error: "無效的數值" });
  }
});

// 更改順序 (管理員)
app.post('/admin/reorder', protect, (req, res) => {
  const { oldIndex, newIndex } = req.body;
  const q = readQueue();
  if (
    typeof oldIndex === 'number' && oldIndex >= 0 && oldIndex < q.length &&
    typeof newIndex === 'number' && newIndex >= 0 && newIndex < q.length
  ) {
    const [item] = q.splice(oldIndex, 1);
    q.splice(newIndex, 0, item);
    writeQueue(q);
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: "無效的索引" });
  }
});

// 管理員強制切歌 (帶原因與圖片)
app.post('/admin/skip', protect, (req, res) => {
  const { reason, image } = req.body;
  const q = readQueue();
  
  // 執行切歌邏輯
  let skippedItem = null;
  if (q.length > 0) {
    skippedItem = q.shift();
    writeQueue(q);

    // 執行停權 (5分鐘)
    if (skippedItem.requester && skippedItem.requester.id) {
      const users = readUsers();
      if (!users[skippedItem.requester.id]) users[skippedItem.requester.id] = {};
      users[skippedItem.requester.id].bannedUntil = Date.now() + BAN_DURATION;
      writeUsers(users);
    }
  }

  // 紀錄訊息供前端顯示
  lastSkipMessage = {
    type: 'admin',
    reason: reason || '',
    image: image || null,
    title: skippedItem ? skippedItem.title : '',
    requester: (skippedItem && skippedItem.requester) ? skippedItem.requester.name : '未知',
    banDuration: Math.ceil(BAN_DURATION / 60000),
    timestamp: Date.now()
  };

  res.json({ ok: true });
});

// 取得最新的切歌訊息
app.get('/skip-message', (req, res) => res.json(lastSkipMessage || {}));

app.use((req, res, next) => {
  const protectPages = ["/display.html", "/admin.html"];
  if (protectPages.includes(req.path)) {
    return protect(req, res, next);
  }
  next();
});

app.use(express.static(__dirname));


// health
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
