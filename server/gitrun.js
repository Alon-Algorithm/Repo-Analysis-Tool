// server/gitrun.js
//
// Thin, promise-based wrappers around child processes. Every git invocation
// runs with GIT_TERMINAL_PROMPT=0 so a missing credential never hangs the
// server waiting for input.

import { spawn } from 'node:child_process';

export function gitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
}

function tailJoin(chunks, lines = 3) {
  return Buffer.concat(chunks)
    .toString('utf8')
    .trim()
    .split('\n')
    .slice(-lines)
    .join(' | ');
}

/**
 * Runs a command to completion, collecting stdout/stderr.
 * Resolves { stdout, stderr } (Buffers) on exit code 0, rejects otherwise.
 */
export function run(cmd, args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? gitEnv(),
      stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
      } else {
        const e = new Error(`${cmd} ${args.join(' ')} failed (exit ${code}): ${tailJoin(err)}`);
        e.code = code;
        e.stderr = Buffer.concat(err);
        reject(e);
      }
    });
    if (input != null) child.stdin.end(input);
  });
}

/** Runs git and returns stdout as a UTF-8 string. */
export async function git(args, opts = {}) {
  const { stdout } = await run('git', args, opts);
  return stdout.toString('utf8');
}

/**
 * Streams `git ...` stdout chunk by chunk (used for the numstat extraction)
 * while keeping a small stderr tail for error reporting.
 */
export function streamGit(args, { cwd, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: gitEnv() });
    const errTail = [];
    child.stdout.on('data', (d) => onStdout(d));
    child.stderr.on('data', (d) => {
      errTail.push(d);
      if (errTail.length > 16) errTail.shift();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} failed (exit ${code}): ${tailJoin(errTail)}`));
    });
  });
}

/**
 * Full (non-shallow) bare clone with live progress.
 * onProgress(phase, percent) is called from stderr lines like
 * "Receiving objects:  42% (123/456)".
 */
export function cloneBare(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--bare', '--progress', url, dest], { env: gitEnv() });
    const errTail = [];
    let lastPercent = -1;
    child.stderr.on('data', (d) => {
      const text = d.toString('utf8');
      errTail.push(text);
      if (errTail.length > 16) errTail.shift();
      if (onProgress) {
        for (const line of text.split(/[\r\n]+/)) {
          const m = /^([A-Za-z][A-Za-z ]*?):\s+(\d+)%/.exec(line);
          if (!m) continue;
          const pct = Number(m[2]);
          if (pct >= lastPercent) {
            lastPercent = pct;
            onProgress(m[1].trim(), pct);
          }
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone failed (exit ${code}): ${errTail.join('').trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

/** Extracts a ZIP archive into destDir using the system unzip. */
export function unzipFile(zipPath, destDir) {
  return run('unzip', ['-q', '-o', zipPath, '-d', destDir]);
}
