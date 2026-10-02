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
const FOLDERED_FILE = path.join(DATA, 'foldered.json');
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
  if (!fs.existsSync(RULES_FILE)) {
    die(
      [
        `未找到 ${RULES_FILE}`,
        '',
        `  它是**你自己的**分类规则，仓库里不提供 —— 只给了 rules.example.json 作参考。`,
        '  那个示例是按「游戏 + 二次元」偏重的收藏调的，直接套用多半不适合你。',
        '',
        '  推荐做法：先看清自己的收藏构成，再据此写',
        '      node xhh.mjs stats',
        '',
        '  只想先跑通看看效果，可以复制示例：',
        `      ${process.platform === 'win32' ? 'copy' : 'cp'} rules.example.json rules.json`,
      ].join('\n')
    );
  }
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

/**
 * 扫描所有已存在的收藏夹，返回 { linkid: {name, id} }。
 * 「全部收藏」列表里其实混着一些已经在收藏夹里的条目，
 * 不先摸清就会把它们从用户已经整理好的夹里拽出来。
 */
async function scanFoldered(verbose = true) {
  const folders = (await cli.folders()).filter((f) => !f.is_default);
  const map = {};
  for (const f of folders) {
    if (verbose) process.stdout.write(`\r  扫描「${f.name}」...                    `);
    try {
      const links = await cli.folderLinksAll(f.id);
      for (const l of links) if (l.linkid) map[l.linkid] = { name: f.name, id: f.id };
      if (verbose) process.stdout.write(`\r  「${f.name}」读到 ${links.length}/${f.count} 条\n`);
    } catch (e) {
      if (verbose) process.stdout.write(`\r  ⚠ 「${f.name}」读取失败：${e.message}\n`);
    }
  }
  return map;
}

async function cmdScan() {
  console.log('扫描已有收藏夹内容 ...');
  const map = await scanFoldered(true);
  writeJson(FOLDERED_FILE, { scanned_at: new Date().toISOString(), count: Object.keys(map).length, map });
  console.log(`\n✓ ${Object.keys(map).length} 条收藏已在收藏夹中 -> ${FOLDERED_FILE}`);
  console.log('  下次 plan 会用这份快照排除掉它们');
}

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

    // 注意：cli.request() 返回的是完整响应体，条目在 result.links 里
    const batch = r.result?.links || [];
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

/**
 * 打印该用户收藏的构成画像。
 *
 * 目的是**为分类规则的编写提供依据** —— 拿这里的真实数据去问用户想怎么分，
 * 而不是空问「你想怎么分类」（用户答不上来），也不要直接套用示例规则。
 */
function cmdStats() {
  const d = readJson(FAV_FILE);
  if (!d) die(`未找到 ${FAV_FILE}，请先运行 node xhh.mjs fetch`);
  const links = d.items.filter(usable).map((x) => x.link);
  const linksAll = d.items.map((x) => x.link).filter(Boolean);

  const tally = (fn, src = linksAll) => {
    const m = new Map();
    for (const l of src) {
      const k = String(fn(l));
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const top = (map, n) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k}(${v})`)
      .join('  ');

  console.log(`收藏总数 ${d.items.length}，其中 is_deleted=1 的 ${d.deleted} 条，可归类 ${links.length} 条`);
  console.log('（以下统计只基于「可归类」的条目）\n');
  console.log('link_type 分布:', tally((l) => l.link_type).map(([k, v]) => `${k}=${v}`).join('  '));

  const tf = new Map();
  const hf = new Map();
  for (const l of links) {
    for (const t of l.topics || []) tf.set(t.name, (tf.get(t.name) || 0) + 1);
    for (const h of l.hashtags || []) hf.set(h.name, (hf.get(h.name) || 0) + 1);
  }

  console.log('\n话题 Top25:');
  console.log('  ' + top(tf, 25));
  console.log('\n标签 Top25:');
  console.log('  ' + top(hf, 25));

  const noTopic = links.filter((l) => !(l.topics || []).length && !(l.hashtags || []).length).length;
  console.log(`\n既无话题也无标签（难以归类）: ${noTopic} 条`);

  console.log(
    [
      '',
      '── 下一步：写你自己的 rules.json ──',
      '  仓库只提供 rules.example.json 作语法参考。那份是按一份「游戏 + 二次元」偏重的收藏',
      '  调出来的，直接套用多半不适合你。',
      '',
      '  照着上面这份画像，挑出你收藏里最重要的几个主题当作收藏夹 ——',
      '  榜单前几名、或你明显想单独归成一类的那些。再照 README 的「分类规则」格式写 rules.json。',
      '  （若你是在替别人跑：把上面的 Top 话题/标签拿给对方看，问他想怎么分。',
      '    空问「你想怎么分类」，对方通常答不上来。）',
      '',
      '  写好后：node xhh.mjs scan && node xhh.mjs plan',
    ].join('\n')
  );
}

function cmdPlan() {
  const d = readJson(FAV_FILE);
  if (!d) die(`未找到 ${FAV_FILE}，请先运行 node xhh.mjs fetch`);
  const rules = loadRules();
  const buckets = new Map(rules.map((r) => [r.folder, []]));
  const unassigned = [];

  const csv = ['folder,keyword,linkid,title'];
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""').slice(0, 80)}"`;

  // 已有收藏夹快照：这些条目用户已经整理过了，绝不能再动
  const snap = readJson(FOLDERED_FILE, null);
  const foldered = snap?.map || null;
  const alreadyFoldered = [];

  for (const it of d.items) {
    if (!usable(it)) continue;
    const id = it.link.linkid;
    if (foldered && foldered[id]) {
      alreadyFoldered.push({ linkid: id, title: it.link.title, folder: foldered[id].name });
      csv.push([csvCell('(已在收藏夹)'), csvCell(foldered[id].name), id, csvCell(it.link.title)].join(','));
      continue;
    }
    const hit = classify(it.link, rules);
    if (hit) {
      buckets.get(hit.rule.folder).push({ linkid: id, title: it.link.title, type: it.link.link_type });
      csv.push([csvCell(hit.rule.folder), csvCell(hit.kw), id, csvCell(it.link.title)].join(','));
    } else {
      unassigned.push({ linkid: id, title: it.link.title });
      csv.push([csvCell('(未归类)'), csvCell(''), id, csvCell(it.link.title)].join(','));
    }
  }
  fs.writeFileSync(path.join(DATA, 'plan.csv'), '\ufeff' + csv.join('\n'));

  const folders = [...buckets.entries()]
    .filter(([, v]) => v.length)
    .map(([folder, links]) => ({ folder, count: links.length, sample: links.slice(0, 5), linkids: links.map((x) => x.linkid) }))
    .sort((a, b) => b.count - a.count);

  // 适配度自检：让脚本单独使用时也能自己发现「这套规则不适合这份收藏」
  const classified = folders.reduce((a, f) => a + f.count, 0);
  const fitBase = classified + unassigned.length;
  const biggest = folders[0];
  const fitness = {
    unassigned_pct: fitBase ? +((unassigned.length / fitBase) * 100).toFixed(1) : 0,
    biggest_folder: biggest?.folder || null,
    biggest_pct: fitBase && biggest ? +((biggest.count / fitBase) * 100).toFixed(1) : 0,
  };
  fitness.suspect = fitness.unassigned_pct > 30 || fitness.biggest_pct > 50;

  const plan = {
    created_at: new Date().toISOString(),
    total: d.items.length,
    usable: d.items.filter(usable).length,
    skipped: d.items.length - d.items.filter(usable).length,
    already_foldered: alreadyFoldered.length,
    foldered_snapshot: snap?.scanned_at || null,
    folders,
    unassigned_count: unassigned.length,
    unassigned_sample: unassigned.slice(0, 15),
    fitness,
  };
  writeJson(PLAN_FILE, plan);

  const lines = [
    `# 收藏整理方案`,
    ``,
    `- 生成时间：${plan.created_at}`,
    `- 收藏总数：${plan.total}（可归类 ${plan.usable}，跳过失效/空条目 ${plan.skipped}）`,
    `- 已在收藏夹中、不再改动：${plan.already_foldered}${plan.foldered_snapshot ? '' : '（未扫描，建议先运行 node xhh.mjs scan）'}`,
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

  console.log(`可归类 ${plan.usable} 条，跳过失效/空 ${plan.skipped} 条，未归类 ${plan.unassigned_count} 条`);
  if (snap) console.log(`已在收藏夹中（本次不动）：${alreadyFoldered.length} 条  [快照 ${snap.scanned_at}]`);
  else console.log(`⚠ 还没扫描过已有收藏夹，建议先跑 node xhh.mjs scan，否则可能把已归档的条目拽出来`);
  console.log('');
  for (const f of folders) {
    console.log(`  ${String(f.count).padStart(6)}  ${f.folder.padEnd(6)}  ${f.sample.slice(0, 2).map((s) => String(s.title).slice(0, 26)).join(' | ')}`);
  }
  console.log(`\n✓ 方案已写入 ${PLAN_FILE} 与 ${PLAN_MD}（未改动账号）`);

  console.log('\n── 规则适配度自检 ──');
  console.log(`  未归类占比  ${fitness.unassigned_pct}%   （>30% 说明规则没抓住这份收藏的主要兴趣）`);
  if (fitness.biggest_folder) {
    console.log(`  最大夹占比  ${fitness.biggest_pct}%   「${fitness.biggest_folder}」  （>50% 说明分类过粗，建议拆开）`);
  }

  if (fitness.suspect) {
    const why = [];
    if (fitness.unassigned_pct > 30) why.push(`未归类 ${fitness.unassigned_pct}% 偏高`);
    if (fitness.biggest_pct > 50) why.push(`「${fitness.biggest_folder}」独占 ${fitness.biggest_pct}%`);
    console.log(
      [
        '',
        `  ⚠ ${why.join('；')} —— 这份 rules.json 多半不适合你的收藏。`,
        '',
        '    改法：先 `node xhh.mjs stats` 看清自己的 Top 话题 / 标签，',
        '          照着它们重写 rules.json，再重新 plan。',
        '    （如果你就是只想抽出其中某几类、其余留在默认夹，那这个比例是正常的，可继续。）',
        '',
        '    确认要按现状执行的话：',
        '      node xhh.mjs apply --only <收藏夹名> --limit 20 --yes    ← 先小批量试跑',
      ].join('\n')
    );
  } else {
    console.log('');
    console.log('  ✓ 看起来合理，可以进入人工审阅（看 data/plan.csv）');
    console.log('');
    console.log('  预览无误后执行：node xhh.mjs apply --only <收藏夹名> --limit 20 --yes');
  }
}

// ------------------------------------------------------------------ 执行

function loadState() {
  return readJson(STATE_FILE, { moved: {}, folders: {}, failures: [], started_at: null });
}

/**
 * 带退避的移动。
 *
 * 降低风控风险的三个手段都集中在这里：
 *   - 退避时间加抖动，避免固定节奏这种明显的机器人特征
 *   - 被限流后自适应调大请求间隔
 *   - 连续被拦超过 ctl.maxBlock 次就整体中止本次运行，而不是继续硬撞
 *     （继续打只会延长封禁；状态已落盘，晚点重跑即可续上）
 */
async function moveWithRetry(folderId, linkId, ctl) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await cli.moveLink(folderId, linkId);
      ctl.blockStreak = 0; // 成功即清零
      return { ok: true, r };
    } catch (e) {
      const msg = e.message;

      if (/403/.test(msg)) {
        ctl.blockStreak = (ctl.blockStreak || 0) + 1;
        ctl.blocks = (ctl.blocks || 0) + 1;

        if (ctl.blockStreak > ctl.maxBlock) {
          return { ok: false, aborted: true, msg };
        }
        if (attempt >= 8) return { ok: false, msg };

        const base = Math.min(30000 * 2 ** attempt, 300000);
        const wait = Math.round(base * (0.8 + Math.random() * 0.4)); // 抖动 ±20%
        ctl.throttle = Math.min(ctl.throttle + 200, 4000); // 自适应降速
        console.log(
          `\n  ⚠ 限流(403) 第 ${ctl.blockStreak}/${ctl.maxBlock} 次，` +
            `退避 ${(wait / 1000).toFixed(0)}s，间隔调至 ${ctl.throttle}ms ...`
        );
        await sleep(wait);
        continue;
      }

      if (/容量不够/.test(msg)) return { ok: false, msg, capacity: true };
      if (/不存在/.test(msg)) return { ok: false, msg, notFound: true };
      if (attempt < 3) {
        await sleep((1000 * (attempt + 1)) | 0);
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
  // 保守默认：1 秒起步 + 抖动 + 每 200 条歇 60 秒 + 连续被拦 5 次就收手
  const ctl = {
    throttle: Number(arg('throttle', 1000)),
    pauseEvery: Number(arg('pause-every', 200)),
    pauseMs: Number(arg('pause-ms', 60000)),
    maxBlock: Number(arg('max-block', 5)),
    blocks: 0,
    blockStreak: 0,
  };

  let targets = plan.folders;
  if (only) {
    targets = targets.filter((f) => f.folder === only);
    if (!targets.length) die(`方案里没有名为「${only}」的收藏夹。可选：${plan.folders.map((f) => f.folder).join(', ')}`);
  }

  const state = loadState();
  const totalPlanned = targets.reduce((a, f) => a + f.linkids.length, 0);
  console.log(`目标：${targets.length} 个收藏夹，计划移动 ${totalPlanned} 条`);
  console.log(`已完成（历史累计）：${Object.keys(state.moved).length} 条`);

  // 把 plan 阶段的适配度结论带到这里。跳过 plan 输出、直接执行的人也得看见。
  if (plan.fitness?.suspect) {
    console.log(
      [
        '',
        `  ⚠ 提醒：plan 的适配度自检判定这份 rules.json 可疑`,
        `     （未归类 ${plan.fitness.unassigned_pct}%${plan.fitness.biggest_folder ? `，最大夹「${plan.fitness.biggest_folder}」占 ${plan.fitness.biggest_pct}%` : ''}）`,
        '     如果你是有意只抽出某几类，可以继续；否则建议先改 rules.json 重跑 plan。',
      ].join('\n')
    );
  }

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

  // 关键安全检查：先摸清哪些条目已经在收藏夹里
  // 「全部收藏」列表里混着这类条目，直接移会把用户已整理好的内容拽出来
  let foldered = {};
  if (!has('no-scan')) {
    console.log('\n扫描已有收藏夹（避免把已归档的内容拽出来）...');
    foldered = await scanFoldered(true);
    console.log(`  ${Object.keys(foldered).length} 条已在收藏夹中\n`);
  } else {
    console.log('\n⚠ 已用 --no-scan 跳过安全检查，已在收藏夹中的条目可能被移走\n');
  }
  let skippedFoldered = 0;

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

      // 已在别的收藏夹里 -> 尊重用户原有的整理，跳过
      const already = foldered[linkid];
      if (already && already.id !== targetId) {
        state.moved[linkid] = `${f.folder} (跳过:原在「${already.name}」)`;
        skippedFoldered++;
        continue;
      }
      // 已经在目标夹里 -> 视为已完成，不重复请求
      if (already && already.id === targetId) {
        state.moved[linkid] = f.folder;
        continue;
      }

      const r = await moveWithRetry(targetId, linkid, ctl);

      if (r.aborted) {
        writeJson(STATE_FILE, state);
        writeJson(UNDO_FILE, undo);
        console.log(`\n⏸ 连续被限流 ${ctl.maxBlock} 次，已主动中止本次运行（继续打只会延长封禁）。`);
        console.log(`  本次已移 ${movedThisRun} 条，累计 ${Object.keys(state.moved).length} 条，进度已保存。`);
        console.log(`  建议等 30 分钟以上、或换个网络出口，再重跑同一条命令即可续上。`);
        process.exit(0);
      }

      if (r.ok) {
        state.moved[linkid] = f.folder;
        undo.push({ linkid, folder: f.folder, folder_id: targetId, from: already?.id ?? 0, at: new Date().toISOString() });
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

      // 间隔加抖动：固定节奏是很明显的机器人特征
      await sleep(Math.round(ctl.throttle * (0.6 + Math.random() * 0.8)));

      // 每 N 条歇一会儿，模拟人工分批操作
      if (ctl.pauseEvery > 0 && movedThisRun > 0 && movedThisRun % ctl.pauseEvery === 0) {
        console.log(`\n  ⏸ 已连续移动 ${movedThisRun} 条，休息 ${(ctl.pauseMs / 1000).toFixed(0)}s ...`);
        writeJson(STATE_FILE, state);
        writeJson(UNDO_FILE, undo);
        await sleep(ctl.pauseMs);
      }
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
  if (skippedFoldered) console.log(`  跳过 ${skippedFoldered} 条：它们本来就在别的收藏夹里，已保持原样`);
  if (ctl.blocks) console.log(`  期间被限流 ${ctl.blocks} 次，最终间隔 ${ctl.throttle}ms`);
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

/** 手动把单条收藏移动到指定收藏夹，用于纠正个别误判 */
async function cmdMove() {
  const link = arg('link');
  const to = arg('to');
  if (!link || !to) die('用法：node xhh.mjs move --link <linkid> --to <收藏夹名> [--yes]');
  const folders = await cli.folders();
  const f = folders.find((x) => x.name === to);
  if (!f) die(`没有名为「${to}」的收藏夹。现有：${folders.map((x) => x.name).join('、')}`);
  console.log(`把 ${link} 移动到「${f.name}」(id=${f.id})`);
  if (!has('yes')) {
    console.log('（预演模式，加 --yes 才会执行）');
    return;
  }
  await cli.moveLink(f.id, Number(link));
  console.log('✓ 完成');
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
  scan: cmdScan,
  fetch: cmdFetch,
  stats: cmdStats,
  plan: cmdPlan,
  apply: cmdApply,
  status: cmdStatus,
  undo: cmdUndo,
  move: cmdMove,
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
      '  node xhh.mjs scan                             扫描已有收藏夹（plan 前建议先跑）',
      '  node xhh.mjs fetch                            拉取全部收藏（可续跑）',
      '  node xhh.mjs stats                            统计字段分布',
      '  node xhh.mjs plan                             生成归类方案（只读）',
      '  node xhh.mjs apply [--only 名称] [--limit N] --yes   执行建夹与移动',
      '     风控相关：[--throttle 1000] [--pause-every 200] [--pause-ms 60000] [--max-block 5]',
      '  node xhh.mjs status                           查看进度',
      '  node xhh.mjs undo --yes                       撤销还原',
      '  node xhh.mjs move --link <id> --to <夹名> --yes  手动移动单条（纠正误判）',
      '  node xhh.mjs cleanup --yes                    删除本工具建的空收藏夹',
    ].join('\n')
  );
  process.exit(cmd ? 1 : 0);
}

try {
  await commands[cmd]();
} catch (e) {
  const msg = e?.message || String(e);
  if (/未找到.*cookie\.txt/.test(msg)) {
    console.error(
      [
        '',
        '✖ 还没有配置 Cookie',
        '',
        '  1. 把 cookie.txt.example 复制为 cookie.txt',
        '       Windows:  copy cookie.txt.example cookie.txt',
        '       macOS/Linux:  cp cookie.txt.example cookie.txt',
        '  2. 浏览器打开 https://xiaoheihe.cn/app/user/favour/content 并确认已登录',
        '  3. F12 -> Network -> F5，筛选 xiaoheihe，点任一 api.xiaoheihe.cn 请求',
        '  4. Request Headers 里复制 Cookie: 后的整段值，粘贴进 cookie.txt',
        '',
      ].join('\n')
    );
  } else {
    console.error(`\n✖ ${msg}\n`);
  }
  process.exit(1);
}
