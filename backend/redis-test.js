const { createClient } = require("redis");

async function testRedis() {
  const redis = createClient({
    url: "redis://localhost:6379"
  });

  redis.on("error", (err) => {
    console.error("Redis error:", err);
  });

  await redis.connect();

  const reply = await redis.ping();
  console.log("Redis response:", reply);

  await redis.quit();
}

testRedis().catch(console.error);