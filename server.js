const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // npm install node-fetch@2
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 抓 videoId
function extractVideoId(url) {
  const match = url.match(/v=([^&]+)/);
  if (match) return match[1];
  const shortMatch = url.match(/youtu\.be\/([^?]+)/);
  return shortMatch ? shortMatch[1] : null;
}

// 抓影片標題
async function fetchVideoTitle(videoId) {
  const apiKey = "AIzaSyBEa3LCMKLL8cBJW_l7TPlylbMyxNFDvD0"; // 替換成你的 API key
  try {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${apiKey}`);
    const data = await res.json();
    if (data.items && data.items.length > 0) return data.items[0].snippet.title;
  } catch(e) { console.error('fetchVideoTitle error:', e); }
  return null;
}

// 觀眾送出點歌
app.post('/request', async (req,res)=>{
  try{
    const { url } = req.body;
    if(!url) return res.status(400).json({ error: 'No URL provided' });

    const videoId = extractVideoId(url);
    if(!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

    const title = await fetchVideoTitle(videoId);
    if(!title) return res.status(500).json({ error: 'Failed to fetch video title' });

    let queue = [];
    if(fs.existsSync('requests.json')){
      try{ queue = JSON.parse(fs.readFileSync('requests.json')); } 
      catch(err){ console.error('Error parsing requests.json:',err); queue=[]; }
    }

    queue.push({ url, title });
    fs.writeFileSync('requests.json', JSON.stringify(queue,null,2));
    console.log(`Added to queue: ${title}`);
    res.json({ ok:true, title });
  } catch(err){
    console.error('Error in /request:',err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// 取得下一首
app.get('/next',(req,res)=>{
  let queue=[];
  if(fs.existsSync('requests.json')) queue=JSON.parse(fs.readFileSync('requests.json'));
  res.json(queue.length ? queue[0] : { url:null, title:null });
});

// 播放完成移除
app.post('/finish',(req,res)=>{
  let queue=[];
  if(fs.existsSync('requests.json')) queue=JSON.parse(fs.readFileSync('requests.json'));
  queue.shift();
  fs.writeFileSync('requests.json',JSON.stringify(queue,null,2));
  res.json({ok:true});
});

// 取得完整 queue
app.get('/queue',(req,res)=>{
  let queue=[];
  if(fs.existsSync('requests.json')) queue=JSON.parse(fs.readFileSync('requests.json'));
  res.json(queue);
});

// 刪除指定索引
app.post('/delete/:index',(req,res)=>{
  let queue=[];
  if(fs.existsSync('requests.json')) queue=JSON.parse(fs.readFileSync('requests.json'));
  const idx=parseInt(req.params.index);
  if(!isNaN(idx)&&idx>=0&&idx<queue.length) queue.splice(idx,1);
  fs.writeFileSync('requests.json',JSON.stringify(queue,null,2));
  res.json({ok:true});
});

app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
