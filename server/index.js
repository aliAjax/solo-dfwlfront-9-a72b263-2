import { createApp } from './app.js';

const port = Number(process.env.PORT || 3001);
const dbPath = process.env.DB_PATH || new URL('../data/app.db', import.meta.url).pathname;
const testHooks = process.env.TEST_HOOKS === '1';

const { app } = createApp({ dbPath, testHooks });
app.listen(port, () => {
  console.log(`油站设备巡检闭环服务已启动: http://localhost:${port}`);
  console.log(`数据库文件: ${dbPath}`);
});
