// request.js

// --- Toast 彈出視窗 ---
function showToast(title, msg, type = 'info') {
  // 如果已存在 toast，先移除
  const old = document.getElementById("toastBox");
  if (old) old.remove();

  const box = document.createElement("div");
  box.id = "toastBox";
  
  let bg = "rgba(0,0,0,0.85)";
  let icon = "✨";
  if (type === 'error') { bg = "rgba(220, 53, 69, 0.95)"; icon = "❌"; }
  else if (type === 'success') { bg = "rgba(40, 167, 69, 0.95)"; icon = "✅"; }
  else if (type === 'warn') { bg = "rgba(255, 193, 7, 0.95)"; icon = "⚠️"; }

  Object.assign(box.style, {
    position: "fixed", top: "20px", left: "50%", transform: "translateX(-50%) translateY(-20px)",
    background: bg, backdropFilter: "blur(10px)", border: "1px solid rgba(255,255,255,0.1)",
    padding: "16px 24px", borderRadius: "12px", color: "#fff", textAlign: "center",
    fontFamily: "'Arial', sans-serif", boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
    opacity: "0", transition: "all 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55)", zIndex: "9999",
    display: "flex", flexDirection: "column", gap: "6px", minWidth: "250px"
  });

  box.innerHTML = `
    <div style="font-size:16px; font-weight:700; display:flex; align-items:center; justify-content:center; gap:8px;">
      <span>${icon}</span> ${title}
    </div>
    <div style="font-size:14px; color:rgba(255,255,255,0.9);">${msg}</div>
  `;

  document.body.appendChild(box);

  // 動畫出現
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      box.style.opacity = "1";
      box.style.transform = "translateX(-50%) translateY(0)";
    });
  });

  // 3 秒後消失
  setTimeout(() => {
    box.style.opacity = "0";
    box.style.transform = "translateX(-50%) translateY(-20px)";
    setTimeout(() => box.remove(), 400);
  }, 3000);
}

// --- 搜尋功能 ---
function searchYT() {
  const q = document.getElementById('searchInput').value.trim();
  const box = document.getElementById('searchList');
  const btn = document.querySelector('button[onclick="searchYT()"]');

  if (!q) {
    box.innerHTML = '';
    return;
  }

  box.innerHTML = '🔍 搜尋中…';
  if (btn) btn.classList.add('btn-loading');

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
    })
    .finally(() => {
      if (btn) btn.classList.remove('btn-loading');
    });
}

function sendRequestByVideoId(videoId) {
  const url = 'https://www.youtube.com/watch?v=' + videoId;
  sendRequest(url);
}

function sendRequestFromInput() {
  const url = document.getElementById('urlInput').value.trim();
  const btn = document.querySelector('button[onclick="sendRequestFromInput()"]');
  if (!url) {
    showToast("錯誤", "請輸入連結或使用搜尋", "error");
    return;
  }
  if (btn) btn.classList.add('btn-loading');
  sendRequest(url, btn);
}

// --- 點歌 API ---
function sendRequest(url, btnElement = null) {
  // 觸發 reCAPTCHA v3
  grecaptcha.ready(function() {
    grecaptcha.execute(RECAPTCHA_SITE_KEY, {action: 'request'}).then(function(token) {
      window.executeSendRequest(url, token, btnElement);
    });
  });
}

window.executeSendRequest = function(url, token, btnElement = null) {
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
        showToast("點歌成功", data.title + " 已加入隊列", "success");
        document.getElementById('urlInput').value = '';
        updateQueue();
        document.getElementById('searchList').innerHTML = ''; // 清空搜尋結果

      } else if (data.error && data.error.includes("排隊中")) {
        showToast("重複點歌", data.error, "warn");
      } else {
        showToast("錯誤", data.error || '加入失敗', "error");
      }
    })
    .catch(err => {
      console.error('request error', err);
      showToast("錯誤", "傳送失敗：" + err.message, "error");
    })
    .finally(() => {
      if (btnElement) btnElement.classList.remove('btn-loading');
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
