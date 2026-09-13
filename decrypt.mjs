#!/usr/bin/env node
/* 命令行解密器 / 校验器（Node 18+，零依赖）
 *
 * 用法：
 *   node decrypt.mjs --config                 读 config.js，解出 tokenBlob 里的 Token（默认打码）
 *   node decrypt.mjs --config --show          同上，但打印完整 Token
 *   node decrypt.mjs --config --check         再调一次 GitHub API，确认 Token 和仓库能对上
 *   node decrypt.mjs "<密文>" "<口令>" [--show]  手动指定密文和口令
 *   node decrypt.mjs --selftest               自检：加密再解密一遍，确认算法实现正常
 *
 * 密文格式与 crypto.js / encrypt.html 完全一致：MAI1.<迭代次数>.<salt b64>.<iv b64>.<密文 b64>
 */
import { pbkdf2Sync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const MAGIC = 'MAI1';
const KEY_BYTES = 32;
const TAG_BYTES = 16;

/** 解密 MAI1 密文，返回明文；口令错/密文损坏会抛错 */
export function decryptBlob(blob, passphrase) {
  const parts = String(blob ?? '').trim().split('.');
  if (parts.length !== 5 || parts[0] !== MAGIC) {
    throw new Error(`密文格式不正确，应该形如 ${MAGIC}.<迭代次数>.<salt>.<iv>.<密文>`);
  }
  const iterations = Number.parseInt(parts[1], 10);
  if (!(iterations > 0)) throw new Error('密文里的迭代次数不合法');
  const salt = Buffer.from(parts[2], 'base64');
  const iv = Buffer.from(parts[3], 'base64');
  const body = Buffer.from(parts[4], 'base64');
  if (!salt.length || !iv.length || body.length <= TAG_BYTES) throw new Error('密文数据不完整');

  const key = pbkdf2Sync(passphrase, salt, iterations, KEY_BYTES, 'sha256');
  const tag = body.subarray(body.length - TAG_BYTES);
  const data = body.subarray(0, body.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('口令不正确，或密文被修改过');
  }
}

/** 加密（仅用于自检；正式加密请用 encrypt.html，保证盐和 IV 来自密码学随机数） */
export function encryptBlob(plaintext, passphrase, iterations = 250000) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(passphrase, salt, iterations, KEY_BYTES, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return [MAGIC, iterations, salt.toString('base64'), iv.toString('base64'), body.toString('base64')].join('.');
}

function mask(token) {
  const t = String(token);
  if (t.length <= 16) return t.slice(0, 4) + '…';
  return t.slice(0, 12) + '…' + t.slice(-4) + `（共 ${t.length} 字符）`;
}

/** 从 config.js 里抠出 tokenBlob / passphrase / owner / repo / branch */
export function readConfig(text = readFileSync(new URL('./config.js', import.meta.url), 'utf8')) {
  const pick = (key) => {
    const m = new RegExp(`${key}\\s*:\\s*(['"])([\\s\\S]*?)\\1`).exec(text);
    return m ? m[2] : '';
  };
  return {
    tokenBlob: pick('tokenBlob'),
    passphrase: pick('passphrase'),
    owner: pick('owner'),
    repo: pick('repo'),
    branch: pick('branch') || 'main',
    submitMode: pick('submitMode'),
    proxyUrl: pick('proxyUrl'),
  };
}

/** 交互式读取口令（终端里不回显）；非 TTY 时退回普通读取 */
function askPassphrase(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      const rl = createInterface({ input: stdin, output: process.stdout });
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
      return;
    }
    process.stdout.write(question);
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let buffer = '';
    const onData = (chunk) => {
      if (chunk === '\r' || chunk === '\n' || chunk === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(buffer);
      } else if (chunk === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      } else if (chunk === '\u007f') {
        buffer = buffer.slice(0, -1);
        process.stdout.write('\b \b');
      } else {
        buffer += chunk;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function checkToken(token, cfg) {
  if (!cfg.owner || !cfg.repo) {
    console.log('  （config.js 里没写 owner/repo，跳过在线校验）');
    return;
  }
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log(`  ❌ 在线校验失败：HTTP ${res.status} ${body.message || ''}`);
    return;
  }
  const perms = body.permissions || {};
  console.log(`  ✅ Token 可用：${body.full_name}（${body.private ? '私有' : '公开'}）`);
  console.log(`     权限：push=${!!perms.push} admin=${!!perms.admin}（提交点歌需要 push）`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));

  if (flags.has('--selftest')) {
    const sample = 'github_pat_示例Token_日本語もOK';
    const pass = 'test-passphrase-1234';
    const blob = encryptBlob(sample, pass);
    const back = decryptBlob(blob, pass);
    let wrongRejected = false;
    try { decryptBlob(blob, 'wrong-pass'); } catch { wrongRejected = true; }
    console.log(`自检：往返=${back === sample ? 'OK' : '失败'}，错误口令被拒绝=${wrongRejected ? 'OK' : '失败'}`);
    console.log(`密文示例：${blob.slice(0, 60)}…`);
    process.exit(back === sample && wrongRejected ? 0 : 1);
  }

  let blob, pass, cfg = {};
  if (flags.has('--config')) {
    cfg = readConfig();
    if (!cfg.tokenBlob) {
      console.log('config.js 里还没有 tokenBlob。先用 encrypt.html 生成一份密文。');
      process.exit(1);
    }
    blob = cfg.tokenBlob;
    pass = cfg.passphrase;
    if (!pass) pass = await askPassphrase('config.js 里没写口令，请输入口令（不回显）：');
  } else if (positional.length >= 2) {
    [blob, pass] = positional;
  } else {
    console.log('用法：');
    console.log('  node decrypt.mjs --config [--show] [--check]');
    console.log('  node decrypt.mjs "<密文>" "<口令>" [--show]');
    console.log('  node decrypt.mjs --selftest');
    process.exit(1);
  }

  let token;
  try {
    token = decryptBlob(blob, pass).trim();
  } catch (err) {
    console.log('❌ ' + err.message);
    process.exit(1);
  }

  console.log('✅ 解密成功');
  console.log('   Token：' + (flags.has('--show') ? token : mask(token)));
  if (flags.has('--check')) await checkToken(token, cfg);
  console.log(flags.has('--show') ? '' : '   （要打印完整 Token 加 --show）');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('出错了：' + err.message); process.exit(1); });
}
