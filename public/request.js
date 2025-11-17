// Request (add to queue) — accepts either full URL or videoId via url param
app.post('/request', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL provided' });

    // Support full URL or videoId
    let videoId = extractVideoId(url);
    if (!videoId) {
      // maybe user sent only videoId
      const maybeId = url.trim();
      if (/^[a-zA-Z0-9_-]{8,}$/.test(maybeId)) videoId = maybeId;
    }
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL or ID' });

    const fullUrl = "https://www.youtube.com/watch?v=" + videoId;

    // ① 讀取 queue
    const queue = readQueue();

    // ② 檢查是否重複（比對 videoId 或 url）
    const already = queue.some(item => {
      const id = extractVideoId(item.url);
      return id === videoId;
    });

    if (already) {
      return res.status(400).json({
        error: '此歌曲已在排隊中，請選擇其他歌曲'
      });
    }

    // ③ 抓取影片資訊
    const info = await fetchVideoInfo(videoId);
    if (!info) {
      return res.status(500).json({ error: 'Failed to fetch video info. Check API key.' });
    }

    // ④ 寫入 queue
    queue.push({
      url: fullUrl,
      title: info.title,
      channel: info.channel,
      thumbnail: info.thumbnail
    });

    writeQueue(queue);

    console.log('Added:', info.title);

    res.json({ ok: true, title: info.title });

  } catch (e) {
    console.error('/request error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});
