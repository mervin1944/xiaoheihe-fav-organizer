/**
 * 小黑盒收藏接口封装（已实测验证）
 * ---------------------------------------------------------------
 * 认证：cookie（cookie.txt）
 * 签名：hkey = f(请求路径, _time, nonce)，由字符集映射 + 交错 + MD5 混淆生成，实现见下方 getHkey()
 *
 * 已实测确认的接口：
 *   GET  /bbs/app/profile/fav/folders                    -> result.folders[{id,name,count,is_default}]
 *   GET  /bbs/app/profile/fav/folder/v2/links            -> result.links[{link,unread,is_deleted}], result.has_next
 *   GET  /bbs/app/profile/fav/folder/links?folder_id=    -> 某收藏夹内的条目
 *   POST /bbs/app/profile/fav/folder/add   {name}        -> result.folder{id,...}
 *   POST /bbs/app/profile/fav/folder/move  {folder_id,link_id}   一次只能移一条
 *   POST /bbs/app/profile/fav/folder/del   {folder_id}
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const BASE = 'https://api.xiaoheihe.cn';

const HKEY_CHARSET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89';
const Vm = (e) => (e & 128 ? 255 & ((e << 1) ^ 27) : e << 1);
const qm = (e) => Vm(e) ^ e;
const dollarM = (e) => qm(Vm(e));
const Ym = (e) => dollarM(qm(Vm(e)));
const Gm = (e) => Ym(e) ^ dollarM(e) ^ qm(e);

function Km(arr) {
  const e = [...arr];
  const t = [
    Gm(e[0]) ^ Ym(e[1]) ^ dollarM(e[2]) ^ qm(e[3]),
    qm(e[0]) ^ Gm(e[1]) ^ Ym(e[2]) ^ dollarM(e[3]),
    dollarM(e[0]) ^ qm(e[1]) ^ Gm(e[2]) ^ Ym(e[3]),
    Ym(e[0]) ^ dollarM(e[1]) ^ qm(e[2]) ^ Gm(e[3]),
  ];
  e[0] = t[0];
  e[1] = t[1];
  e[2] = t[2];
  e[3] = t[3];
  return e;
}

const mapCharset = (s, cs) => [...s].map((c) => cs[c.charCodeAt(0) % cs.length]).join('');

export function getHkey(pathname, timestamp, nonce) {
  const cs = HKEY_CHARSET;
  const norm = '/' + pathname.split('/').filter(Boolean).join('/') + '/';
  const comps = [
    mapCharset(String(timestamp), cs.slice(0, -2)),
    mapCharset(norm, cs),
    mapCharset(nonce, cs),
  ];
  const mx = Math.max(...comps.map((c) => c.length));
  let il = '';
  for (let k = 0; k < mx; k++) for (const c of comps) if (k < c.length) il += c[k];
  const md5 = crypto.createHash('md5').update(il.slice(0, 20)).digest('hex');
  const prefix = mapCharset(md5.slice(0, 5), cs.slice(0, -4));
  const km = Km([...md5.slice(-6)].map((c) => c.charCodeAt(0)));
  return prefix + String(km.reduce((a, b) => a + b, 0) % 100).padStart(2, '0');
}

export const generateNonce = () =>
  crypto.createHash('md5').update(String(Date.now()) + Math.random()).digest('hex').toUpperCase();

const COMMON = {
  os_type: 'web',
  app: 'heybox',
  client_type: 'web',
  version: '999.0.4',
  web_version: '2.5',
  x_client_type: 'web',
  x_app: 'heybox_website',
  x_os_type: 'Windows',
  device_info: 'Chrome',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class XhhClient {
  constructor({ root }) {
    this.root = root;
    this.cookieFile = path.join(root, 'cookie.txt');
    this.configFile = path.join(root, 'config.json');
    this._cookie = null;
    this.deviceId = this._deviceId();
  }

  _deviceId() {
    let cfg = {};
    if (fs.existsSync(this.configFile)) {
      try {
        cfg = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      } catch {
        cfg = {};
      }
    }
    if (!cfg.device_id) {
      cfg.device_id = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(this.configFile, JSON.stringify(cfg, null, 2));
    }
    return cfg.device_id;
  }

  get cookie() {
    if (this._cookie) return this._cookie;
    if (!fs.existsSync(this.cookieFile)) {
      throw new Error(
        `未找到 ${this.cookieFile}\n` +
          '  请把 cookie.txt.example 复制为 cookie.txt，再按其中的说明粘贴登录 Cookie。'
      );
    }
    const raw = fs
      .readFileSync(this.cookieFile, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join('; ')
      .replace(/^cookie\s*:\s*/i, '');
    if (!/=\S/.test(raw)) throw new Error('cookie.txt 里没有有效的 cookie');
    this._cookie = raw;
    return raw;
  }

  /** 发请求。params 走 query，opts.form 走 POST 表单体 */
  async request(pathname, params = {}, opts = {}) {
    const ts = Math.floor(Date.now() / 1000);
    const n = generateNonce();
    const q = { ...COMMON, ...params, device_id: this.deviceId, hkey: getHkey(pathname, ts, n), _time: ts, nonce: n };
    const url = new URL(BASE + pathname);
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const headers = {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://xiaoheihe.cn/',
      Origin: 'https://xiaoheihe.cn',
      Cookie: this.cookie,
    };
    const init = { method: opts.method || 'GET', headers };
    if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const usp = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) {
        if (Array.isArray(v)) v.forEach((x) => usp.append(k, String(x)));
        else usp.append(k, String(v));
      }
      init.body = usp.toString();
    }
    if (opts.signal) init.signal = opts.signal;

    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    if (opts.raw) return { http: res.status, json, text };
    if (!json) throw new Error(`返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    if (json.status === 'login') throw new Error('cookie 无效或已过期，请重新复制 cookie.txt');
    return json;
  }

  async ok(pathname, params, opts) {
    const j = await this.request(pathname, params, opts);
    if (j.status !== 'ok') throw new Error(`${pathname} 失败：${j.status} / ${j.msg}`);
    return j.result;
  }

  // ------------------------------------------------------------ 读

  /** 全部收藏夹 */
  async folders() {
    const r = await this.ok('/bbs/app/profile/fav/folders');
    return r.folders || [];
  }

  /** 全部收藏（分页），onProgress 回调用于显示进度 */
  async allFavourites(onProgress) {
    const out = [];
    let offset = 0;
    for (;;) {
      const r = await this.ok('/bbs/app/profile/fav/folder/v2/links', {
        enable_new_style_collect: 1,
        offset,
        limit: 30,
        dw: 1280,
      });
      const batch = r.links || [];
      out.push(...batch);
      if (onProgress) onProgress(out.length, batch.length);
      if (String(r.has_next) !== '1' || batch.length === 0) break;
      offset += 30;
      await sleep(300);
      if (out.length > 100000) break;
    }
    return out;
  }

  /** 某个收藏夹内的一页条目（服务端硬性每页最多 30 条，传更大的 limit 无效） */
  async folderLinks(folderId, limit = 30) {
    const r = await this.ok('/bbs/app/profile/fav/folder/links', { folder_id: folderId, offset: 0, limit });
    return (r.links || []).map((x) => x.link).filter(Boolean);
  }

  /** 某个收藏夹内的全部条目，靠 result.folder.count 判断终点并翻页 */
  async folderLinksAll(folderId, onPage) {
    const out = [];
    let offset = 0;
    for (;;) {
      const r = await this.ok('/bbs/app/profile/fav/folder/links', { folder_id: folderId, offset, limit: 30 });
      const batch = (r.links || []).map((x) => x.link).filter(Boolean);
      out.push(...batch);
      const total = Number(r.folder?.count ?? 0);
      if (onPage) onPage(out.length, total);
      if (batch.length === 0) break;
      if (total && out.length >= total) break;
      offset += 30;
      await sleep(300);
      if (out.length > 100000) break;
    }
    return out;
  }

  // ------------------------------------------------------------ 写

  /** 新建收藏夹，返回 {id,name,count} */
  async addFolder(name) {
    const r = await this.ok('/bbs/app/profile/fav/folder/add', {}, { method: 'POST', form: { name } });
    return r.folder;
  }

  /** 把一条收藏移入收藏夹（一次一条，接口不支持批量） */
  async moveLink(folderId, linkId) {
    return this.ok('/bbs/app/profile/fav/folder/move', {}, {
      method: 'POST',
      form: { folder_id: folderId, link_id: linkId },
    });
  }

  /** 删除收藏夹 */
  async delFolder(folderId) {
    return this.ok('/bbs/app/profile/fav/folder/del', {}, { method: 'POST', form: { folder_id: folderId } });
  }

  /** 确保同名收藏夹存在，存在则复用 */
  async ensureFolder(name) {
    const list = await this.folders();
    const hit = list.find((f) => f.name === name);
    if (hit) return { ...hit, created: false };
    const f = await this.addFolder(name);
    return { ...f, created: true };
  }
}
