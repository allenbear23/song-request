require('dotenv').config();
const fetch = require('node-fetch');

async function testModel(modelId, inputs) {
    const hfApiKey = process.env.HF_API_KEY;
    if (!hfApiKey) {
        console.error("HF_API_KEY not found in .env");
        return;
    }
    console.log(`Testing model: ${modelId}`);
    try {
        const response = await fetch(
            `https://api-inference.huggingface.co/models/${modelId}`,
            {
                headers: {
                    Authorization: `Bearer ${hfApiKey}`,
                    "Content-Type": "application/json",
                },
                method: "POST",
                body: JSON.stringify({ inputs }),
            }
        );
        console.log(`Status: ${response.status} ${response.statusText}`);
        const result = await response.json();
        console.log(`Result:`, JSON.stringify(result).substring(0, 200));
    } catch (e) {
        console.error(`Error testing ${modelId}:`, e);
    }
}

async function runTasks() {
    await testModel("meta-llama/Llama-3.2-3B-Instruct", "Hello");
    await testModel("unitary/multilingual-toxic-xlm-roberta", "I love you");
    await testModel("meta-llama/Llama-3.1-8B-Instruct", "Hello");
    await testModel("Qwen/Qwen2.5-7B-Instruct", "Hello");
}

runTasks();
