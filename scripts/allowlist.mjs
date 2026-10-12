// 收尾模式的允許清單（FR-4.7）。純函式，不做 I/O。
import { basename, resolve } from 'node:path';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// Edit／Write 修改既有檔案前必須先 Read，所以也允許 Read 收尾用的檔案。
const FILE_TOOLS = new Set(['Write', 'Edit', 'Read']);
const WRITE_TOOLS = new Set(['Write', 'Edit']);

// 規格列出的串接字元，另加單一個 &（bash 的背景執行、PowerShell 的呼叫運算子）。
const FORBIDDEN = [';', '&', '|', '`', '$(', '>', '<', '\n', '\r'];
const GIT_ADD_OR_COMMIT = /^git\s+(add|commit)(\s|$)/;
const GIT_COMMIT = /^git\s+commit(\s|$)/;
// git commit 成功時的摘要行，例如「[main 1a2b3c4] 訊息」或「[main (root-commit) 1a2b3c4] 訊息」。
const COMMIT_SUMMARY = /^\[[^\]\n]+ [0-9a-f]{7,}\]/m;

export function isAllowedShellCommand(command) {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  return GIT_ADD_OR_COMMIT.test(trimmed) && !FORBIDDEN.some((c) => trimmed.includes(c));
}

function normalize(path, platform) {
  return platform === 'win32' ? path.toLowerCase() : path;
}

function isResumeFile(target, cwd, config, platform) {
  const resumeFile = config.resume_file;
  // 只有檔名時比對檔名（FR-4.7）；含路徑時比對相對於 cwd 的完整路徑。
  if (/[\\/]/.test(resumeFile)) return normalize(target, platform) === normalize(resolve(cwd, resumeFile), platform);
  return normalize(basename(target), platform) === normalize(resumeFile, platform);
}

function isPlanFile(target, cwd, config, platform) {
  return config.plan_files.some((p) => normalize(target, platform) === normalize(resolve(cwd, p), platform));
}

function targetPath(input) {
  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath) return null;
  return resolve(input.cwd || process.cwd(), filePath);
}

export function isAllowedDuringStop(input, config, platform = process.platform) {
  if (SHELL_TOOLS.has(input.tool_name)) return isAllowedShellCommand(input.tool_input?.command);
  if (!FILE_TOOLS.has(input.tool_name)) return false;
  const target = targetPath(input);
  if (!target) return false;
  const cwd = input.cwd || process.cwd();
  return isResumeFile(target, cwd, config, platform) || isPlanFile(target, cwd, config, platform);
}

// PostToolUse：這次呼叫是否寫入了 resume_file。
export function wroteResumeFile(input, config, platform = process.platform) {
  if (!WRITE_TOOLS.has(input.tool_name)) return false;
  const target = targetPath(input);
  return Boolean(target) && isResumeFile(target, input.cwd || process.cwd(), config, platform);
}

// PostToolUse：這次呼叫是否成功完成了一次 git commit。
export function isSuccessfulCommit(input) {
  if (!SHELL_TOOLS.has(input.tool_name)) return false;
  const command = input.tool_input?.command;
  if (!isAllowedShellCommand(command) || !GIT_COMMIT.test(command.trim())) return false;
  const response = input.tool_response;
  const output =
    typeof response === 'string'
      ? response
      : [response?.stdout, response?.output, response?.stderr].filter((s) => typeof s === 'string').join('\n');
  return COMMIT_SUMMARY.test(output);
}
