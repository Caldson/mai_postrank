/* 提交凭据的加解密（浏览器端，WebCrypto）
 *
 * 密文格式（一行，方便直接粘进 config.js）：
 *   MAI1.<迭代次数>.<salt b64>.<iv b64>.<密文 b64>
 *
 * 算法：PBKDF2-SHA256 派生密钥 → AES-256-GCM 加密（自带完整性校验，口令错或密文被改都会失败）
 * 加密器：encrypt.html     命令行解密：node decrypt.mjs
 */
(function () {
  'use strict';

  var MAGIC = 'MAI1';
  var ITERATIONS = 250000;
  var SALT_BYTES = 16;
  var IV_BYTES = 12;

  function toBase64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function fromBase64(b64) {
    var bin = atob(String(b64 == null ? '' : b64).replace(/\s+/g, ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function subtle() {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      throw new Error('当前环境不支持 WebCrypto：请用 https 或 http://localhost 打开本页');
    }
    return crypto.subtle;
  }

  function deriveKey(passphrase, salt, iterations) {
    var api = subtle();
    return api.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return api.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }

  function encrypt(plaintext, passphrase) {
    if (!passphrase) return Promise.reject(new Error('口令不能为空'));
    var api = subtle();
    var salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    var iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    return deriveKey(passphrase, salt, ITERATIONS).then(function (key) {
      return api.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(String(plaintext)));
    }).then(function (cipher) {
      return [MAGIC, ITERATIONS, toBase64(salt), toBase64(iv), toBase64(new Uint8Array(cipher))].join('.');
    });
  }

  function decrypt(blob, passphrase) {
    var parts = String(blob == null ? '' : blob).trim().split('.');
    if (parts.length !== 5 || parts[0] !== MAGIC) {
      return Promise.reject(new Error('密文格式不正确，应该形如 ' + MAGIC + '.<迭代次数>.<salt>.<iv>.<密文>'));
    }
    var iterations = parseInt(parts[1], 10);
    if (!(iterations > 0)) return Promise.reject(new Error('密文里的迭代次数不合法'));
    var salt, iv, data;
    try {
      salt = fromBase64(parts[2]);
      iv = fromBase64(parts[3]);
      data = fromBase64(parts[4]);
    } catch (e) {
      return Promise.reject(new Error('密文里的 base64 数据损坏'));
    }
    return deriveKey(passphrase, salt, iterations).then(function (key) {
      return subtle().decrypt({ name: 'AES-GCM', iv: iv }, key, data);
    }).then(function (buf) {
      return new TextDecoder().decode(buf);
    }).catch(function () {
      throw new Error('口令不正确，或密文被修改过');
    });
  }

  /** 口令强度提示（不是硬性要求，只用来提醒） */
  function passphraseHint(passphrase) {
    var p = String(passphrase || '');
    var kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(function (re) { return re.test(p); }).length;
    if (p.length < 8) return { level: 'weak', text: '口令太短（建议 12 位以上随机字符）' };
    if (p.length >= 12 && kinds >= 3) return { level: 'good', text: '口令强度不错' };
    return { level: 'ok', text: '口令可用，再长一些会更稳' };
  }

  window.MaiCrypto = {
    encrypt: encrypt,
    decrypt: decrypt,
    passphraseHint: passphraseHint,
    ITERATIONS: ITERATIONS,
    FORMAT: MAGIC + '.<迭代次数>.<salt>.<iv>.<密文>',
  };
})();
