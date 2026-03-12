console.log("YT_API_KEY exists:", !!process.env.YT_API_KEY);
console.log("HF_API_KEY exists:", !!process.env.HF_API_KEY);
if (process.env.YT_API_KEY) {
    console.log("YT_API_KEY prefix:", process.env.YT_API_KEY.substring(0, 5));
}
if (process.env.HF_API_KEY) {
    console.log("HF_API_KEY prefix:", process.env.HF_API_KEY.substring(0, 5));
}
