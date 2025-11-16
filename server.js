// server.js
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
app.post('/request', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL provided' });

    // Support either full url or videoId
    let videoId = extractVideoId(url);
    if (!videoId) {
      // maybe user sent only videoId
      const maybeId = url.trim();
      if (/^[a-zA-Z0-9_-]{8,}$/.test(maybeId)) videoId = maybeId;
    }
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL or ID' });

    const info = await fetchVideoInfo(videoId);
    if (!info) return res.status(500).json({ error: 'Failed to fetch video info. Check API key or video id.' });

    const queue = readQueue();
    // push object with fields: url (full), title, channel, thumbnail
    const fullUrl = 'https://www.youtube.com/watch?v=' + videoId;
    queue.push({ url: fullUrl, title: info.title, channel: info.channel, thumbnail: info.thumbnail });
    writeQueue(queue);

    console.log('Added to queue:', info.title);
    res.json({ ok: true, title: info.title });
  } catch (e) {
    console.error('/request error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
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

// health
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
