// request.js

function sendMessage(m) {
  const el = document.getElementById('msg');
  el.innerText = m || '';
}

// Search YouTube via server-side /search
function searchYT() {
  const q = document.getElementById('searchInput').value.trim();
  const box = document.getElementById('searchList');
  if (!q) { box.innerHTML = ''; return; }
  box.innerHTML = '搜尋中…';

  fetch('/search?q=' + encodeURIComponent(q))
    .then(r => r.json())
    .then(list => {
      box.innerHTML = '';
      if (!list || list.length === 0) {
        box.innerHTML = '<div class="small">找不到結果</div>';
        return;
      }
      list.forEach(it => {
        const div = document.createElement('div');
        div.className = 'search-result';
        div.onclick = () => sendRequestByVideoId(it.videoId);
        div.innerHTML = `<img src="${it.thumbnail}" alt=""><div><div class="title">${it.title}</div><div class="channel">${it.channel}</div></div>`;
        box.appendChild(div);
      });
    })
    .catch(err => {
      console.error('search error', err);
      box.innerHTML = '<div class="small">搜尋發生錯誤</div>';
    });
}

// send by videoId
function sendRequestByVideoId(videoId) {
  const url = 'https://www.youtube.com/watch?v=' + videoId;
  sendRequest(url);
}

// send by url (used by input field)
function sendRequestFromInput() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) { sendMessage('請貼上 YouTube 連結或用搜尋'); return; }
  sendRequest(url);
}

// send request to server to add to queue
function sendRequest(url) {
  sendMessage('傳送中…');
  fetch('/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  })
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        sendMessage('✔️ 已加入：' + data.title);
        document.getElementById('urlInput').value = '';
        updateQueue();
      } else {
        sendMessage('❌ ' + (data.error || '加入失敗'));
      }
    })
    .catch(err => {
      console.error('request error', err);
      sendMessage('❌ 傳送失敗: ' + (err.message || err));
    });
}

// update local queue display
function updateQueue() {
  fetch('/queue')
    .then(r => r.json())
    .then(list => {
      const ul = document.getElementById('queueList');
      ul.innerHTML = '';
      list.forEach((it, idx) => {
        const li = document.createElement('li');
        li.innerText = `${idx + 1}. ${it.title} (${it.channel || ''})`;
        ul.appendChild(li);
      });
    })
    .catch(err => console.error('updateQueue error', err));
}

updateQueue();
setInterval(updateQueue, 5000);
