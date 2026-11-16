// 模擬對話框程序：依參數輸出按下的按鈕索引、延遲，或以錯誤結束。
// 用法：node fake-dialog.mjs <輸出> [延遲毫秒] [exit code]
const [output = '', delayMs = '0', exitCode = '0'] = process.argv.slice(2);
// PowerShell 冷啟動時會把進度寫到 stderr（A14），模擬這個雜訊。
process.stderr.write('#< CLIXML\n');
setTimeout(() => {
  process.stdout.write(output);
  process.exitCode = Number(exitCode);
}, Number(delayMs));
