// server.js (FINAL FULL VERSION)
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // node-fetch@2
const app = express();
const PORT = process.env.PORT || 3000;

const YT_API_KEY = "AIzaSyBEa3LCMKLL8cBJW_l7TPlylbMyxNFDvD0";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function readQueue() {
  try {
    if (!fs.existsSync('requests.json')) return [];
    return JSON.parse(fs.readFileSync('requests.json', 'utf8') || '[]');
  } catch (e) { console.error(e); return []; }
}
function writeQueue(q) {
  try { fs.writeFileSync('requests.json', JSON.stringify(q, null, 2)); } 
  catch (e) { console.error(e); }
}

function extractVideoId(url) {
  if (!url) return null;
  const m = url.match(/v=([^&]+)/);
  if (m) return m[1];
  const s = url.match(/youtu\.be\/([^?&]+)/);
  return s ? s[1] : null;
}

async function fetchVideoInfo(videoId) {
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${YT_API_KEY}`);
    const data = await res.json();
    if (!data.items || !data.items.length) return null;
    const snip = data.items[0].snippet;
    return {
      title: snip.title,
      channel: snip.channelTitle,
      thumbnail: snip.thumbnails?.high?.url || snip.thumbnails?.medium?.url || snip.thumbnails?.default?.url
    };
  } catch (e) { console.error(e); return null; }
}

// --- APIs ---

app.get("/search", async (req,res)=>{
  const q = (req.query.q||'').trim();
  if (!q) return res.json([]);
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(q)}&key=${YT_API_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    if (!data.items) return res.json([]);
    const results = data.items.map(it=>({
      id: it.id.videoId,
      title: it.snippet.title,
      channel: it.snippet.channelTitle,
      thumbnail: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url
    }));
    res.json(results);
  } catch(e){ console.error(e); res.json([]); }
});

app.post("/request", async (req,res)=>{
  try{
    const { url } = req.body;
    if (!url) return res.status(400).json({ error:'No URL provided' });

    let videoId = extractVideoId(url);
    if (!videoId && /^[a-zA-Z0-9_-]{8,}$/.test(url.trim())) videoId = url.trim();
    if (!videoId) return res.status(400).json({ error:'Invalid YouTube URL or ID' });

    const info = await fetchVideoInfo(videoId);
    if (!info) return res.status(500).json({ error:'Failed to fetch video info' });

    const queue = readQueue();
    queue.push({ id: videoId, url:`https://www.youtube.com/watch?v=${videoId}`, title: info.title, channel: info.channel, thumbnail: info.thumbnail });
    writeQueue(queue);
    console.log('Added:', info.title);
    res.json({ ok:true, title: info.title });
  } catch(e){ console.error(e); res.status(500).json({ error:'Server error' }); }
});

app.get("/next",(req,res)=>{
  const q = readQueue();
  if (!q.length) return res.json({ id:null, title:null, channel:null, thumbnail:null });
  const s = q[0];
  res.json({ id:s.id, title:s.title, channel:s.channel, thumbnail:s.thumbnail });
});

app.post("/finish",(req,res)=>{
  const q = readQueue(); if(q.length) q.shift(); writeQueue(q);
  res.json({ ok:true });
});

app.get("/queue",(req,res)=>res.json(readQueue()));
app.post("/delete/:index",(req,res)=>{
  const idx = parseInt(req.params.index); const q=readQueue();
  if(!isNaN(idx)&&idx>=0&&idx<q.length) q.splice(idx,1); writeQueue(q);
  res.json({ ok:true });
});

app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
