require('dotenv').config();
const fetch = require('node-fetch');

async function searchYouTubeServerSide(query) {
  try {
    const exactQuery = query + " Official Music Video";
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(exactQuery)}&key=${process.env.YT_API_KEY}`;
    console.log("Search URL:", searchUrl);
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();

    if (!searchData.items || searchData.items.length === 0) {
      console.log("No items found for:", exactQuery);
      return null;
    }

    console.log("Found", searchData.items.length, "items for", exactQuery);
    console.log("First item title:", searchData.items[0].snippet.title);
  } catch (e) {
    console.error(e);
  }
}

searchYouTubeServerSide("華語 流行 推薦");
searchYouTubeServerSide("Billboard Hot 100");
