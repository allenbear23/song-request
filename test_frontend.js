const fs = require('fs');

const mockData = [{"videoId":"MVD7fhKgGzc","title":"周杰倫最好聽的20首歌曲 | 在雨天聽周杰倫－絕佳的選擇 | Listening to Jay Chou on a rainy day - An excellent choice","channel":"杰威爾歌詞MV頻道JVR Lyric MV","thumbnail":"https://i.ytimg.com/vi/MVD7fhKgGzc/hqdefault.jpg","viewCount":"35400000","publishedAt":"2018-05-15T00:00:00Z"},{"videoId":"dQw4w9WgXcQ","title":"Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)","channel":"Rick Astley","thumbnail":"https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg","viewCount":"1350000000","publishedAt":"2009-10-25T00:00:00Z"},{"videoId":"HmFhhfF68OU","title":"劉大壯 - 最【動態歌詞】「最最最 難忘回憶是與你 最最最 最後一吻的距離」♪","channel":"Angelic Music World","thumbnail":"https://i.ytimg.com/vi/HmFhhfF68OU/hqdefault.jpg","viewCount":"8500","publishedAt":"2023-11-20T00:00:00Z"}];

try {
  mockData.forEach(it => {
    let viewsText = '';
    if (it.viewCount) {
      const views = parseInt(it.viewCount, 10);
      if (views >= 100000000) viewsText = (views / 100000000).toFixed(1) + '億次觀看';
      else if (views >= 10000) viewsText = (views / 10000).toFixed(1) + '萬次觀看';
      else viewsText = views.toLocaleString() + '次觀看';
    }

    let dateText = '';
    if (it.publishedAt) {
      const date = new Date(it.publishedAt);
      dateText = `・${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    }
    console.log(`Title: ${it.title}`);
    console.log(`Stats: ${viewsText} ${dateText}`);
  });
} catch(e) {
  console.error("Error formatting data:", e);
}
