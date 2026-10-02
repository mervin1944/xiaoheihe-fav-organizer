#!/usr/bin/env node
/**
 * 小黑盒收藏整理工具
 * ===============================================================
 * 用你自己的登录 cookie，把「默认收藏夹」里的内容按分类自动归入「收藏夹」。
 *
 * 接口细节（全部实测验证过）见 xhhlib.mjs 顶部注释。
 *
 * 常用流程：
 *   node xhh.mjs check                     验证 cookie
 *   node xhh.mjs fetch                     拉取全部收藏（可续跑）
 *   node xhh.mjs plan                      生成归类方案（只读，不动账号）
 *   node xhh.mjs apply --only 碧蓝档案 --limit 20 --yes    先小批量试跑
 *   node xhh.mjs apply --yes               全量执行
 *   node xhh.mjs status                    查看执行进度
 *   node xhh.mjs undo --yes                撤销（尽力还原到原收藏夹/默认收藏夹）
 *
 * 安全设计：
 *   - plan 完全不写账号；apply 默认是预演，必须加 --yes
 *   - 每条移动都写入 data/undo.json，可追溯
 *   - 已完成的移动写入 data/apply-state.json，中断后可续跑，不会重复
 *   - 遇到 403 限流自动指数退避；遇到「容量不够」自动开同名分夹
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XhhClient, sleep } from './xhhlib.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const FAV_FILE = path.join(DATA, 'favourites.json');
const PLAN_FILE = path.join(DATA, 'plan.json');
const PLAN_MD = path.join(DATA, 'plan.md');
const STATE_FILE = path.join(DATA, 'apply-state.json');
const UNDO_FILE = path.join(DATA, 'undo.json');
const RULES_FILE = path.join(ROOT, 'rules.json');

const FOLDER_NAME_MAX = 16; // 实测：16 字符可接受，20 被拒
const PAGE_LIMIT = 30;

const cli = new XhhClient({ root: ROOT });

// ------------------------------------------------------------------ 工具

const ensureData = () => fs.mkdirSync(DATA, { recursive: true });
const readJson = (f, d = null) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const writeJson = (f, v) => {
  ensureData();
  fs.writeFileSync(f, JSON.stringify(v, null, 2));
};
const die = (m) => {
  console.error(`\n✖ ${m}\n`);
  process.exit(1);
};
const isAscii = (s) => /^[\x00-\x7F]+$/.test(s);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 取参数值，支持 --name value 与 --name=value 两种写法；纯开关返回 true */
function arg(name, def = null) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) return true;
      return next;
    }
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return def;
}
const has = (name) => arg(name) !== null;

// ------------------------------------------------------------------ 规则

function loadRules() {
  if (!fs.existsSync(RULES_FILE)) die(`未找到 ${RULES_FILE}`);
  const j = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  const rules = (j.folders || []).filter((r) => r && r.folder);
  for (const r of rules) {
    if (r.folder.length > FOLDER_NAME_MAX) {
      console.warn(`⚠ 收藏夹名「${r.folder}」超过 ${FOLDER_NAME_MAX} 字符，可能被服务端拒绝`);
    }
  }
  return rules;
}

function linkText(l) {
  return [l.title, l.description, ...(l.topics || []).map((t) => t.name), ...(l.hashtags || []).map((t) => t.name)]
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();
}

/** 返回命中的关键词（或 'has_video'），未命中返回 null */
function matchRule(l, rule) {
  const m = rule.match || {};
  if (m.has_video === true) return Number(l.has_video) === 1 ? 'has_video' : null;
  if (m.has_video === false && Number(l.has_video) === 1) return null;
  if (m.type_in && !m.type_in.map(Number).includes(Number(l.link_type))) return null;
  const text = linkText(l);
  if (m.keywords_any) {
    const hit = m.keywords_any.find((k) => {
      const key = String(k).toLowerCase();
      if (isAscii(key)) return new RegExp(`(^|[^a-z0-9])${esc(key)}([^a-z0-9]|$)`, 'i').test(text);
      return text.includes(key);
    });
    if (!hit) return null;
    if (m.title_regex && !new RegExp(m.title_regex, 'i').test(l.title || '')) return null;
    return hit;
  }
  if (m.title_regex && !new RegExp(m.title_regex, 'i').test(l.title || '')) return null;
  return '(默认命中)';
}

const classify = (l, rules) => {
  for (const r of rules) {
    const kw = matchRule(l, r);
    if (kw) return { rule: r, kw };
  }
  return null;
};

/** 可归类的条目：有效且非空 */
const usable = (it) => it.link && Number(it.is_deleted) !== 1 && it.link.title && it.link.linkid;

// ------------------------------------------------------------------ 命令

async function cmdCheck() {
  console.log('· 校验 cookie ...');
  const f = await cli.folders();
  console.log('✓ cookie 有效');
  console.log(`  现有收藏夹 ${f.length} 个：`);
  for (const x of f) console.log(`    ${String(x.count).padStart(5)} 条  ${x.name}  (id=${x.id})`);
}

async function cmdFolders() {
  const f = await cli.folders();
  console.log(`收藏夹 ${f.length} 个：`);
  for (const x of f) console.log(`  ${String(x.count).padStart(6)}  ${x.name}  id=${x.id}`);
  const total = f.filter((x) => !x.is_default).reduce((a, x) => a + x.count, 0);
  console.log(`  已归档合计 ${total} 条`);
}

/** 拉取全部收藏。接口在末尾会循环返回重复数据，因此以「连续 3 页无新增」作为结束条件 */
async function cmdFetch() {
  const state = readJson(path.join(DATA, 'fetch-state.json'), { offset: 0, seen: [] });
  const seen = new Set(state.seen);
  const items = readJson(FAV_FILE, { items: [] }).items || [];
  for (const it of items) if (it.link?.linkid) seen.add(it.link.linkid);

  let offset = has('restart') ? 0 : state.offset;
  if (has('restart')) {
    seen.clear();
    items.length = 0;
  }
  console.log(`从 offset=${offset} 开始续拉，已有 ${seen.size} 条唯一收藏`);

  let dryPages = 0;
  let added = 0;
  for (;;) {
    let r;
    let attempt = 0;
    for (;;) {
      try {
        r = await cli.request('/bbs/app/profile/fav/folder/v2/links', {
          enable_new_style_collect: 1,
          offset,
          limit: PAGE_LIMIT,
          dw: 1280,
        });
        break;
      } catch (e) {
        if (/403/.test(e.message) && attempt < 6) {
          const wait = 30000 * 2 ** attempt;
          console.log(`\n  ⚠ 被限流(403)，等待 ${wait / 1000}s 后重试 ...`);
          await sleep(wait);
          attempt++;
          continue;
        }
        throw e;
      }
    }
    if (r.status !== 'ok') die(`拉取失败：${r.status} / ${r.msg}`);

    const batch = r.links || [];
    let fresh = 0;
    for (const it of batch) {
      const id = it.link?.linkid;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push(it);
      fresh++;
    }
    added += fresh;
    offset += PAGE_LIMIT;
    process.stdout.write(`\r  已扫描 ${offset} 条位置，唯一收藏 ${items.length} 条（本页新增 ${fresh}）      `);

    if (batch.length === 0) break;
    if (fresh === 0) {
      dryPages++;
      if (dryPages >= 3) break; // 连续 3 页全重复 => 已到真实末尾
    } else {
      dryPages = 0;
    }

    writeJson(path.join(DATA, 'fetch-state.json'), { offset, seen: [...seen] });
    writeJson(FAV_FILE, {
      fetched_at: new Date().toISOString(),
      count: items.length,
      deleted: items.filter((x) => Number(x.is_deleted) === 1).length,
      items,
    });
    await sleep(Number(arg('throttle', 350)));
  }
  process.stdout.write('\n');
  writeJson(path.join(DATA, 'fetch-state.json'), { offset, seen: [...seen] });
  writeJson(FAV_FILE, {
    fetched_at: new Date().toISOString(),
    count: items.length,
    deleted: items.filter((x) => Number(x.is_deleted) === 1).length,
    items,
  });
  console.log(`✓ 完成：唯一收藏 ${items.length} 条（本次新增 ${added}）-> ${FAV_FILE}`);
}

function cmdStats() {
  const d = readJson(FAV_FILE);
  if (!d) die(`未找到 ${FAV_FILE}，请先运行 node xhh.mjs fetch`);
  const links = d.items.map((x) => x.link).filter(Boolean);
  const tally = (fn) => {
    const m = new Map();
    for (const l of links) m.set(String(fn(l)), (m.get(String(fn(l))) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  console.log(`收藏总数 ${d.items.length}，其中 is_deleted=1 的 ${d.deleted} 条，可归类 ${d.items.filter(usable).length} 条\n`);
  console.log('link_type:', tally((l) => l.link_type).map(([k, v]) => `${k}=${v}`).join('  '));
  const tf = new Map();
  for (const l of links) for (const t of l.topics || []) tf.set(t.name, (tf.get(t.name) || 0) + 1);
  console.log('\n话题 Top20:', [...tf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k}(${v})`).join('  '));
}

function cmdPlan() {
  const d = readJson(FAV_FILE);
  if (!d) die(`未找到 ${FAV_FILE}，请先运行 node xhh.mjs fetch`);
  const rules = loadRules();
  const buckets = new Map(rules.map((r) => [r.folder, []]));
  const unassigned = [];

  const csv = ['folder,keyword,linkid,title'];
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""').slice(0, 80)}"`;

  for (const it of d.items) {
    if (!usable(it)) continue;
    const hit = classify(it.link, rules);
    if (hit) {
      buckets.get(hit.rule.folder).push({ linkid: it.link.linkid, title: it.link.title, type: it.link.link_type });
      csv.push([csvCell(hit.rule.folder), csvCell(hit.kw), it.link.linkid, csvCell(it.link.title)].join(','));
    } else {
      unassigned.push({ linkid: it.link.linkid, title: it.link.title });
      csv.push([csvCell('(未归类)'), csvCell(''), it.link.linkid, csvCell(it.link.title)].join(','));
    }
  }
  fs.writeFileSync(path.join(DATA, 'plan.csv'), '\ufeff' + csv.join('\n'));

  const folders = [...buckets.entries()]
    .filter(([, v]) => v.length)
    .map(([folder, links]) => ({ folder, count: links.length, sample: links.slice(0, 5), linkids: links.map((x) => x.linkid) }))
    .sort((a, b) => b.count - a.count);

  const plan = {
    created_at: new Date().toISOString(),
    total: d.items.length,
    usable: d.items.filter(usable).length,
    skipped: d.items.length - d.items.filter(usable).length,
    folders,
    unassigned_count: unassigned.length,
    unassigned_sample: unassigned.slice(0, 15),
  };
  writeJson(PLAN_FILE, plan);

  const lines = [
    `# 收藏整理方案`,
    ``,
    `- 生成时间：${plan.created_at}`,
    `- 收藏总数：${plan.total}（可归类 ${plan.usable}，跳过失效/空条目 ${plan.skipped}）`,
    `- 将归入 ${folders.length} 个收藏夹，共 ${folders.reduce((a, f) => a + f.count, 0)} 条`,
    `- 未归类（留在默认收藏夹）：${plan.unassigned_count}`,
    ``,
    `| 条数 | 收藏夹 | 示例 |`,
    `| ---: | --- | --- |`,
    ...folders.map((f) => `| ${f.count} | ${f.folder} | ${f.sample.slice(0, 2).map((s) => String(s.title).replace(/\|/g, '/').slice(0, 30)).join('；')} |`),
    ``,
    `## 未归类样例`,
    ``,
    ...plan.unassigned_sample.map((s) => `- ${String(s.title).slice(0, 60)}`),
  ];
  fs.writeFileSync(PLAN_MD, lines.join('\n'));

  console.log(`可归类 ${plan.usable} 条，跳过 ${plan.skipped} 条，未归类 ${plan.unassigned_count} 条\n`);
  for (const f of folders) {
    console.log(`  ${String(f.count).padStart(6)}  ${f.folder.padEnd(6)}  ${f.sample.slice(0, 2).map((s) => String(s.title).slice(0, 26)).join(' | ')}`);
  }
  console.log(`\n✓ 方案已写入 ${PLAN_FILE} 与 ${PLAN_MD}（未改动账号）`);
  console.log(`  预览无误后执行：node xhh.mjs apply --only <收藏夹名> --limit 20 --yes`);
}

// ------------------------------------------------------------------ 执行

function loadState() {
  return readJson(STATE_FILE, { moved: {}, folders: {}, failures: [], started_at: null });
}

/** 带退避的移动；ctl.throttle 会在被限流后自适应调大 */
async function moveWithRetry(folderId, linkId, ctl) {
  for (let attempt = 0; ; attempt++) {
    try {
      await cli.moveLink(folderId, linkId);
      return { ok: true };
    } catch (e) {
      const msg = e.message;
      if (/403/.test(msg) && attempt < 8) {
        const wait = Math.min(30000 * 2 ** attempt, 300000);
        ctl.throttle = Math.min(ctl.throttle + 200, 3000); // 自适应降速
        ctl.blocks = (ctl.blocks || 0) + 1;
        console.log(`\n  ⚠ 限流(403)，退避 ${wait / 1000}s，间隔调至 ${ctl.throttle}ms ...`);
        await sleep(wait);
        continue;
      }
      if (/容量不够/.test(msg)) return { ok: false, msg, capacity: true };
      if (/不存在/.test(msg)) return { ok: false, msg, notFound: true };
      if (attempt < 3) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return { ok: false, msg };
    }
  }
}

async function cmdApply() {
  const exec = has('yes');
  const plan = readJson(PLAN_FILE);
  if (!plan) die(`未找到 ${PLAN_FILE}，请先运行 node xhh.mjs plan`);

  const only = arg('only');
  const limit = Number(arg('limit', 0)) || 0;
  const ctl = { throttle: Number(arg('throttle', 450)), blocks: 0 };

  let targets = plan.folders;
  if (only) {
    targets = targets.filter((f) => f.folder === only);
    if (!targets.length) die(`方案里没有名为「${only}」的收藏夹。可选：${plan.folders.map((f) => f.folder).join(', ')}`);
  }

  const state = loadState();
  const totalPlanned = targets.reduce((a, f) => a + f.linkids.length, 0);
  console.log(`目标：${targets.length} 个收藏夹，计划移动 ${totalPlanned} 条`);
  console.log(`已完成（历史累计）：${Object.keys(state.moved).length} 条`);

  if (!exec) {
    for (const f of targets) {
      const done = f.linkids.filter((id) => state.moved[id]).length;
      console.log(`  ${String(f.linkids.length - done).padStart(6)} 待移动 / ${String(f.linkids.length).padStart(6)} 合计   ${f.folder}`);
    }
    console.log(`\n（预演模式，未改动账号。加 --yes 才会真正执行；可先加 --limit 20 小批量试跑）`);
    return;
  }

  ensureData();
  state.started_at ||= new Date().toISOString();
  const undo = readJson(UNDO_FILE, []);

  let movedThisRun = 0;
  for (const f of targets) {
    // 确保收藏夹存在
    let folder = (await cli.folders()).find((x) => x.name === f.folder);
    if (!folder) {
      if (f.folder.length > FOLDER_NAME_MAX) die(`收藏夹名「${f.folder}」超过 ${FOLDER_NAME_MAX} 字符`);
      folder = await cli.addFolder(f.folder);
      console.log(`+ 新建收藏夹「${f.folder}」id=${folder.id}`);
      await sleep(600);
    }
    state.folders[f.folder] = folder.id;
    let targetId = folder.id;
    let suffix = 1;

    const todo = f.linkids.filter((id) => !state.moved[id]);
    console.log(`\n▶ ${f.folder}：待移动 ${todo.length} 条（总计 ${f.linkids.length}）`);

    let i = 0;
    for (const linkid of todo) {
      if (limit && movedThisRun >= limit) break;
      const r = await moveWithRetry(targetId, linkid, ctl);

      if (r.ok) {
        state.moved[linkid] = f.folder;
        undo.push({ linkid, folder: f.folder, folder_id: targetId, from: 0, at: new Date().toISOString() });
        movedThisRun++;
        i++;
      } else if (r.capacity) {
        suffix++;
        const name = `${f.folder}${suffix}`.slice(0, FOLDER_NAME_MAX);
        console.log(`\n  ⚠ 「${f.folder}」容量不够，改用「${name}」`);
        const nf = await cli.addFolder(name);
        state.folders[name] = nf.id;
        targetId = nf.id;
        await sleep(600);
        continue; // 同一条用新夹重试
      } else if (r.notFound) {
        state.moved[linkid] = `${f.folder} (跳过:${r.msg})`;
      } else {
        state.failures.push({ linkid, folder: f.folder, msg: r.msg, at: new Date().toISOString() });
        console.log(`\n  ✖ ${linkid} 失败：${r.msg}`);
      }

      if (movedThisRun % 20 === 0) {
        writeJson(STATE_FILE, state);
        writeJson(UNDO_FILE, undo);
      }
      const doneAll = Object.keys(state.moved).length;
      process.stdout.write(`\r  ${f.folder}: ${i}/${todo.length}  累计已移 ${doneAll} 条        `);
      await sleep(ctl.throttle);
    }
    writeJson(STATE_FILE, state);
    writeJson(UNDO_FILE, undo);
    process.stdout.write('\n');
    if (limit && movedThisRun >= limit) {
      console.log(`\n已达到 --limit ${limit}，停止。`);
      break;
    }
  }

  writeJson(STATE_FILE, state);
  writeJson(UNDO_FILE, undo);
  console.log(`\n✓ 本次移动 ${movedThisRun} 条；累计 ${Object.keys(state.moved).length} 条；失败 ${state.failures.length} 条`);
  console.log(`  撤销记录：${UNDO_FILE}`);
}

async function cmdStatus() {
  const state = loadState();
  const plan = readJson(PLAN_FILE);
  const moved = Object.keys(state.moved).length;
  console.log(`已移动（累计）：${moved} 条`);
  console.log(`失败：${state.failures.length} 条`);
  if (plan) {
    const planned = plan.folders.reduce((a, f) => a + f.count, 0);
    console.log(`方案总量：${planned} 条，剩余约 ${Math.max(planned - moved, 0)} 条`);
    console.log('\n各夹进度：');
    for (const f of plan.folders) {
      const done = f.linkids.filter((id) => state.moved[id]).length;
      const bar = '█'.repeat(Math.round((done / f.count) * 20)).padEnd(20, '·');
      console.log(`  ${bar} ${String(done).padStart(5)}/${String(f.count).padEnd(5)} ${f.folder}`);
    }
  }
  if (state.failures.length) {
    console.log('\n最近失败：');
    for (const x of state.failures.slice(-10)) console.log(`  ${x.linkid} ${x.folder} ${x.msg}`);
  }
}

async function cmdUndo() {
  const exec = has('yes');
  const undo = readJson(UNDO_FILE, []);
  if (!undo.length) die('没有撤销记录');
  const only = arg('only');
  const list = only ? undo.filter((x) => x.folder === only) : undo;
  console.log(`撤销记录 ${undo.length} 条${only ? `（筛选「${only}」-> ${list.length} 条）` : ''}`);
  if (!exec) {
    console.log('（预演模式，未改动账号。加 --yes 才会执行）');
    console.log('说明：这些条目原本都在默认收藏夹(id=0)，撤销即逐条移回 0。');
    console.log('注意：默认收藏夹原本是满的，需先有足够空间（移出的条数 ≥ 要移回的条数）才能全部成功。');
    return;
  }
  // 逐条反向移动：回到记录的原收藏夹，没有记录则回默认收藏夹(0)
  const ctl = { throttle: Number(arg('throttle', 450)) };
  const okIds = new Set();
  let ok = 0,
    fail = 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const res = await moveWithRetry(r.from ?? 0, r.linkid, ctl);
    if (res.ok) {
      ok++;
      okIds.add(r.linkid);
    } else {
      fail++;
      if (fail <= 5) console.log(`  ✖ ${r.linkid} -> ${r.folder} 失败：${res.msg}`);
    }
    if (i % 20 === 0) process.stdout.write(`\r  已撤销 ${ok} 条，失败 ${fail} 条     `);
    await sleep(ctl.throttle);
  }
  process.stdout.write('\n');
  // undo.json 只保留"当前仍在收藏夹里"的条目，成功撤销的移除（失败的留着便于重试）
  writeJson(UNDO_FILE, undo.filter((x) => !okIds.has(x.linkid)));
  const st = loadState();
  for (const id of okIds) delete st.moved[id];
  writeJson(STATE_FILE, st);
  console.log(`✓ 撤销完成：成功 ${ok}，失败 ${fail}；undo.json 剩余 ${undo.length - okIds.size} 条`);
}

/** 删除本工具创建的、当前为空的收藏夹 */
async function cmdCleanup() {
  const exec = has('yes');
  const state = loadState();
  const names = Object.keys(state.folders);
  if (!names.length) die('没有本工具创建收藏夹的记录');
  const cur = await cli.folders();
  const empties = cur.filter((f) => names.includes(f.name) && f.count === 0);
  console.log(`本工具创建的夹：${names.join(', ')}`);
  console.log(`其中当前为空的：${empties.map((f) => f.name).join(', ') || '（无）'}`);
  if (!exec) {
    console.log('（预演模式，加 --yes 才会删除。只会删空夹，非空的一律不动）');
    return;
  }
  for (const f of empties) {
    await cli.delFolder(f.id);
    console.log(`  已删除空夹「${f.name}」`);
    await sleep(500);
  }
  console.log('✓ 完成');
}

// ------------------------------------------------------------------ main

const commands = {
  check: cmdCheck,
  folders: cmdFolders,
  fetch: cmdFetch,
  stats: cmdStats,
  plan: cmdPlan,
  apply: cmdApply,
  status: cmdStatus,
  undo: cmdUndo,
  cleanup: cmdCleanup,
};

const cmd = process.argv[2];
if (!cmd || !commands[cmd]) {
  console.log(
    [
      '小黑盒收藏整理工具',
      '',
      '  node xhh.mjs check                            验证 cookie',
      '  node xhh.mjs folders                          列出收藏夹',
      '  node xhh.mjs fetch                            拉取全部收藏（可续跑）',
      '  node xhh.mjs stats                            统计字段分布',
      '  node xhh.mjs plan                             生成归类方案（只读）',
      '  node xhh.mjs apply [--only 名称] [--limit N] --yes   执行建夹与移动',
      '  node xhh.mjs status                           查看进度',
      '  node xhh.mjs undo --yes                       撤销还原',
      '  node xhh.mjs cleanup --yes                    删除本工具建的空收藏夹',
    ].join('\n')
  );
  process.exit(cmd ? 1 : 0);
}

await commands[cmd]();
