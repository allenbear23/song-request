// request.js

// --- Toast 彈出視窗 ---
function showToast(title, msg) {
  // 如果已存在 toast，先移除
  const old = document.getElementById("toastBox");
  if (old) old.remove();

  const box = document.createElement("div");
  box.id = "toastBox";
  box.style.position = "fixed";
  box.style.top = "50%";
  box.style.left = "50%";
  box.style.transform = "translate(-50%, -50%) scale(0.7)";
  box.style.background = "rgba(0,0,0,0.85)";
  box.style.padding = "22px 28px";
  box.style.borderRadius = "12px";
  box.style.color = "#fff";
  box.style.textAlign = "center";
  box.style.fontFamily = "Arial";
  box.style.boxShadow = "0 4px 20px rgba(0,0,0,0.45)";
  box.style.opacity = "0";
  box.style.transition = "0.25s";
  box.style.zIndex = "9999";

  box.innerHTML = `
    <div style="font-size:20px; font-weight:700; margin-bottom:6px;">✨ ${title}</div>
    <div style="font-size:15px; color:#ddd;">${msg}</div>
  `;

  document.body.appendChild(box);

  // 動畫出現
  setTimeout(() => {
    box.style.opacity = "1";
    box.style.transform = "translate(-50%, -50%) scale(1)";
  }, 10);

  // 3 秒後消失
  setTimeout(() => {
    box.style.opacity = "0";
    box.style.transform = "translate(-50%, -50%) scale(0.7)";
    setTimeout(() => box.remove(), 250);
  }, 3000);
}

// --- 搜尋功能 ---
function searchYT() {
  const q = document.getElementById('searchInput').value.trim();
  const box = document.getElementById('searchList');

  if (!q) {
    box.innerHTML = '';
    return;
  }

  box.innerHTML = '🔍 搜尋中…';

  fetch('/search?q=' + encodeURIComponent(q))
    .then(r => r.json())
    .then(list => {
      box.innerHTML = '';

      if (!list || list.length === 0) {
        box.innerHTML = '<div class="small">找不到相關影片</div>';
        return;
      }

      list.forEach(it => {
        const div = document.createElement('div');
        div.className = 'search-result';
        div.onclick = () => sendRequestByVideoId(it.videoId);

        div.innerHTML = `
          <img src="${it.thumbnail}" alt="">
          <div>
            <div class="title">${it.title}</div>
            <div class="channel">${it.channel}</div>
          </div>
        `;
        box.appendChild(div);
      });
    })
    .catch(err => {
      console.error('search error', err);
      box.innerHTML = '<div class="small">搜尋錯誤，請稍後再試</div>';
    });
}

function sendRequestByVideoId(videoId) {
  const url = 'https://www.youtube.com/watch?v=' + videoId;
  sendRequest(url);
}

function sendRequestFromInput() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) {
    showToast("錯誤", "請輸入連結或使用搜尋");
    return;
  }
  sendRequest(url);
}

// --- 點歌 API ---
function sendRequest(url) {
  // 觸發 reCAPTCHA v3
  grecaptcha.ready(function() {
    grecaptcha.execute(RECAPTCHA_SITE_KEY, {action: 'request'}).then(function(token) {
      window.executeSendRequest(url, token);
    });
  });
}

window.executeSendRequest = function(url, token) {
  showToast("傳送中…", "請稍候");

  // 準備使用者資料 (若已登入)
  let userData = null;
  if (typeof currentLineProfile !== 'undefined' && currentLineProfile) {
    userData = {
      userId: currentLineProfile.userId,
      displayName: currentLineProfile.displayName,
      pictureUrl: currentLineProfile.pictureUrl
    };
  }

  fetch('/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, token, user: userData })
  })
    .then(r => r.json())
    .then(data => {

      if (data.ok) {
        showToast("點歌成功", data.title + " 已加入隊列");
        document.getElementById('urlInput').value = '';
        updateQueue();
        document.getElementById('searchList').innerHTML = ''; // 清空搜尋結果

      } else if (data.error && data.error.includes("排隊中")) {
        showToast("重複點歌", data.error);
      } else {
        showToast("錯誤", data.error || '加入失敗');
      }
    })
    .catch(err => {
      console.error('request error', err);
      showToast("錯誤", "傳送失敗：" + err.message);
    });
}


// --- Queue 列表更新 ---
function updateQueue() {
  fetch('/queue')
    .then(r => r.json())
    .then(list => {
      const ul = document.getElementById('queueList');
      ul.innerHTML = '';

      if (!list || list.length === 0) {
        ul.innerHTML = '<li style="color:#999">目前沒有排隊歌曲</li>';
        return;
      }

      list.forEach((it, idx) => {
        const li = document.createElement('li');
        li.innerHTML = `
          ${idx + 1}. ${it.title}
          <span style="color:#888; font-size:12px"> - ${it.channel || ''}</span>
        `;
        ul.appendChild(li);
      });
    })
    .catch(err => console.error('updateQueue error', err));
}

// 初始化
updateQueue();
setInterval(updateQueue, 5000);
