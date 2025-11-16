function sendMessage(m){document.getElementById('msg').innerText=m||'';}
function sendRequestByVideoId(videoId){sendRequest('https://www.youtube.com/watch?v='+videoId);}
function sendRequest(url){
  sendMessage('傳送中…');
  fetch('/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})})
    .then(r=>r.json()).then(d=>{if(d.ok){sendMessage('✔️ 已加入：'+d.title);updateQueue();}else sendMessage('❌ '+(d.error||'加入失敗'));})
    .catch(e=>sendMessage('❌ 傳送失敗: '+e.message));
}
function sendRequestFromInput(){const u=document.getElementById('urlInput').value.trim();if(!u){sendMessage('請貼上 YouTube 連結或用搜尋');return;} sendRequest(u);}
function searchYT(){
  const q=document.getElementById('searchInput').value.trim();
  const box=document.getElementById('searchList');
  if(!q){box.innerHTML='';return;}
  box.innerHTML='搜尋中…';
  fetch('/search?q='+encodeURIComponent(q)).then(r=>r.json()).then(list=>{
    box.innerHTML='';if(!list||list.length===0){box.innerHTML='<div>找不到結果</div>';return;}
    list.forEach(it=>{
      const div=document.createElement('div'); div.className='search-result'; div.onclick=()=>sendRequestByVideoId(it.id);
      div.innerHTML=`<img src="${it.thumbnail}"><div><div class="title">${it.title}</div><div class="channel">${it.channel}</div></div>`;
      box.appendChild(div);
    });
  }).catch(e=>{console.error(e);box.innerHTML='<div>搜尋失敗</div>';});
}
function updateQueue(){
  fetch('/queue').then(r=>r.json()).then(list=>{const ul=document.getElementById('queueList');ul.innerHTML='';list.forEach((it,idx)=>{const li=document.createElement('li');li.innerText=`${idx+1}. ${it.title} (${it.channel})`;ul.appendChild(li);});});
}
updateQueue(); setInterval(updateQueue,5000);
