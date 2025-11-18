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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
    const { url, token } = req.body;

    // 驗證 token 是否送來
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
    queue.push({ url: fullUrl, title: info.title, channel: info.channel, thumbnail: info.thumbnail });
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

// Get full queue
app.get('/queue', (req, res) => {
  const q = readQueue();
  res.json(q);
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
app.get("/display.html", protect, (req, res) => {
  res.sendFile(__dirname + "/display.html");
});

app.get("/admin.html", protect, (req, res) => {
  res.sendFile(__dirname + "/admin.html");
});

// health
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
