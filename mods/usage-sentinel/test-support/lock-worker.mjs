// 搶鎖測試用的子程序：等到指定時間後同時搶 race.lock，輸出 won 或 lost。
import { acquireLock } from '../scripts/state.mjs';

const [dir, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {
  // 忙等，讓所有程序盡量同時起跑
}
process.stdout.write(acquireLock(dir, 'race.lock', { ttlSeconds: 60 }) ? 'won' : 'lost');
