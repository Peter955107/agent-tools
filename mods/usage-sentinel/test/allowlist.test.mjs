import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { DEFAULT_CONFIG } from '../scripts/state.mjs';
import { isAllowedDuringStop, isSuccessfulCommit } from '../scripts/allowlist.mjs';

const CWD = resolve('/work/my-app');
const config = { ...structuredClone(DEFAULT_CONFIG), plan_files: ['tasks/todo.md'] };
const allowed = (tool_name, tool_input) => isAllowedDuringStop({ tool_name, tool_input, cwd: CWD }, config);

describe('Bash／PowerShell', () => {
  for (const tool of ['Bash', 'PowerShell']) {
    for (const command of ['git add .', 'git add -A', 'git commit -m "收尾：更新 RESUME"', '  git commit -m wip  ', 'git commit']) {
      test(`${tool} 允許：${command.trim()}`, () => {
        assert.equal(allowed(tool, { command }), true);
      });
    }

    const rejected = [
      'git commit -m x && rm -rf src',
      'git commit -m x; rm x',
      'git commit -m x || echo',
      'git add . | tee log',
      'git commit -m `whoami`',
      'git commit -m $(whoami)',
      'git commit -m x > out.txt',
      'git add < list.txt',
      'git commit -m x\nrm x',
      'git commit -m x\r\nrm x',
      'git commit -m x & rm x',
      'git status',
      'git push',
      'git commit-tree HEAD',
      'gitadd .',
      'echo git commit',
      '',
    ];
    for (const command of rejected) {
      test(`${tool} 拒絕：${JSON.stringify(command)}`, () => {
        assert.equal(allowed(tool, { command }), false);
      });
    }
  }

  test('command 不是字串時拒絕', () => {
    assert.equal(allowed('Bash', {}), false);
  });
});

describe('Write／Edit／Read', () => {
  test('寫入 resume_file（以檔名比對）', () => {
    assert.equal(allowed('Write', { file_path: join(CWD, 'RESUME.md') }), true);
    assert.equal(allowed('Edit', { file_path: join(CWD, 'docs', 'RESUME.md') }), true);
  });

  test('寫入 plan_files（相對於 cwd）', () => {
    assert.equal(allowed('Edit', { file_path: join(CWD, 'tasks', 'todo.md') }), true);
  });

  test('Read resume_file 與 plan_files（Edit／Write 前必須先 Read）', () => {
    assert.equal(allowed('Read', { file_path: join(CWD, 'RESUME.md') }), true);
    assert.equal(allowed('Read', { file_path: join(CWD, 'tasks', 'todo.md') }), true);
  });

  test('其他檔案一律拒絕', () => {
    assert.equal(allowed('Write', { file_path: join(CWD, 'NOT-RESUME.md') }), false);
    assert.equal(allowed('Edit', { file_path: join(CWD, 'src', 'todo.md') }), false);
    assert.equal(allowed('Read', { file_path: join(CWD, 'src', 'index.js') }), false);
  });

  test('Windows 上路徑比對不分大小寫', () => {
    const result = isAllowedDuringStop(
      { tool_name: 'Edit', tool_input: { file_path: join(CWD, 'Tasks', 'TODO.md') }, cwd: CWD },
      config,
      'win32',
    );
    assert.equal(result, true);
  });

  test('resume_file 設成路徑時，比對完整路徑', () => {
    const custom = { ...config, resume_file: 'notes/RESUME.md' };
    assert.equal(isAllowedDuringStop({ tool_name: 'Write', tool_input: { file_path: join(CWD, 'notes', 'RESUME.md') }, cwd: CWD }, custom), true);
    assert.equal(isAllowedDuringStop({ tool_name: 'Write', tool_input: { file_path: join(CWD, 'RESUME.md') }, cwd: CWD }, custom), false);
  });
});

describe('其他工具', () => {
  for (const tool of ['Grep', 'Glob', 'WebFetch', 'Task', 'Agent', 'NotebookEdit']) {
    test(`${tool} 一律拒絕`, () => {
      assert.equal(allowed(tool, { file_path: join(CWD, 'RESUME.md'), command: 'git commit' }), false);
    });
  }
});

describe('isSuccessfulCommit（PostToolUse 判斷 commit 是否成功）', () => {
  test('git 的摘要行代表成功', () => {
    const input = { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, tool_response: { stdout: '[main 1a2b3c4] x\n 1 file changed' } };
    assert.equal(isSuccessfulCommit(input, config), true);
  });

  test('含 root-commit 的摘要行也算', () => {
    const input = { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, tool_response: { stdout: '[main (root-commit) 1a2b3c4] x' } };
    assert.equal(isSuccessfulCommit(input, config), true);
  });

  test('沒有變更可 commit 時不算', () => {
    const input = { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, tool_response: { stdout: 'nothing to commit, working tree clean' } };
    assert.equal(isSuccessfulCommit(input, config), false);
  });

  test('git add 不算 commit', () => {
    const input = { tool_name: 'Bash', tool_input: { command: 'git add .' }, tool_response: { stdout: '[main 1a2b3c4] x' } };
    assert.equal(isSuccessfulCommit(input, config), false);
  });

  test('tool_response 為字串時也能判斷', () => {
    const input = { tool_name: 'PowerShell', tool_input: { command: 'git commit -m x' }, tool_response: '[main 1a2b3c4] x' };
    assert.equal(isSuccessfulCommit(input, config), true);
  });
});
