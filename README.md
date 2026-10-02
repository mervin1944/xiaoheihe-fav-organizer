# xiaoheihe-fav-organizer

[![赞赏 · 爱发电](https://img.shields.io/badge/%E8%B5%9E%E8%B5%8F-%E7%88%B1%E5%8F%91%E7%94%B5-ff69b4)](https://afdian.com/a/mervin1944) [![赞赏 · 微信](https://img.shields.io/badge/%E8%B5%9E%E8%B5%8F-%E5%BE%AE%E4%BF%A1-07C160?logo=wechat&logoColor=white)](assets/wechat-reward.png) [![赞赏 · 支付宝](https://img.shields.io/badge/%E8%B5%9E%E8%B5%8F-%E6%94%AF%E4%BB%98%E5%AE%9D-1677FF?logo=alipay&logoColor=white)](assets/alipay-reward.png)

> 把小黑盒堆满的「默认收藏夹」，按你自己的分类规则批量归入「收藏夹」。

小黑盒的收藏夹管理是 **App 独占功能**：网页端和 PC 客户端都只能看平铺列表，而默认收藏夹有容量上限，
攒满之后就没法再收藏了。这个工具调用后端接口，把堆积的收藏按关键词规则批量归档。

**它只做「建夹」和「移动」，不改动、不删除任何收藏内容。** 没命中规则的条目留在默认夹里原样不动。

> **Unofficial tool.** Not affiliated with HeyBox / 小黑盒 / 清枫. It talks to HeyBox's
> internal, undocumented endpoints. Use at your own risk.

---

## 快速开始

需要 **Node.js 18+**，零依赖，不用 `npm install`。

```bash
git clone https://github.com/mervin1944/xiaoheihe-fav-organizer.git
cd xiaoheihe-fav-organizer
```

### 1. 配置 Cookie

打开 <https://xiaoheihe.cn/app/user/favour/content> 确认已登录，然后：

1. `F12` → **Network / 网络** → `F5` 刷新
2. 筛选 `xiaoheihe`，点任意一条 `api.xiaoheihe.cn` 的请求
3. **Request Headers** 里找到 `Cookie:`，复制冒号后的整段值
4. 存进 `cookie.txt`（从示例复制一份）：

```bash
cp cookie.txt.example cookie.txt        # Windows: copy cookie.txt.example cookie.txt
```

> `cookie.txt` 等同登录凭证，已被 `.gitignore` 排除。**泄露等于账号被接管，不要外发。**

### 2. 拉取收藏，看清它由什么构成

```bash
node xhh.mjs check      # 验证 cookie
node xhh.mjs fetch      # 拉取全部收藏（最慢的一步，可中断续跑）
node xhh.mjs stats      # 打印 Top25 话题 / Top25 标签
```

`stats` 会告诉你收藏里哪些主题最多：

```
话题 Top25:  盒友杂谈(2001)  碧蓝档案(1966)  Steam(772)  数码硬件(763)  动漫(406) …
标签 Top25:  蔚蓝档案(1570)  盒友日常(1531)  同人绘画(1026)  单机游戏(597) …
```

### 3. 照这份数据写 `rules.json`

**`rules.json` 是你自己的文件，仓库不提供。** 仓库只有 `rules.example.json` 作语法参考 ——
那份是按一个「游戏 + 二次元」偏重的收藏调的，**直接套用几乎肯定不适合你**。

照着 `stats` 的榜单，挑出你收藏里最重要的几个主题作为收藏夹：

```json
{
  "folders": [
    { "folder": "壁纸", "match": { "keywords_any": ["壁纸", "wallpaper"] } },
    { "folder": "视频", "match": { "has_video": true } }
  ]
}
```

可用的匹配键见下方[分类规则](#分类规则)。想先跑通看看效果，也可以 `copy rules.example.json rules.json`。

### 4. 出方案 → 试跑 → 全量

```bash
node xhh.mjs scan                                    # 扫描已有收藏夹（不能跳过，见下）
node xhh.mjs plan                                    # 生成方案（只读，不动账号）
node xhh.mjs apply --only 碧蓝档案 --limit 20 --yes   # 先小批量试跑，去 App 里看效果
node xhh.mjs apply --yes                             # 确认无误再全量
node xhh.mjs status                                  # 随时看进度
```

`plan` 会给出**规则适配度自检**，不达标就说明规则没写对：

```
── 规则适配度自检 ──
  未归类占比  3.7%   （>30% 说明规则没抓住这份收藏的主要兴趣）
  最大夹占比  18.5%  「职场生活」  （>50% 说明分类过粗，建议拆开）

  ✓ 看起来合理，可以进入人工审阅（看 data/plan.csv）
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `check` | 验证 cookie，列出收藏夹 |
| `folders` | 列出收藏夹及条数 |
| `fetch` | 拉取全部收藏 → `data/favourites.json`（可中断续跑） |
| `stats` | 打印收藏构成画像（Top25 话题 / Top25 标签） |
| `scan` | 扫描已有收藏夹内容 → `data/foldered.json`（`plan` 依赖它做保护） |
| `plan` | 生成归类方案 → `data/plan.json` / `plan.md` / `plan.csv`（只读） |
| `apply` | 建夹 + 移动，**默认预演**，加 `--yes` 才真正写 |
| `status` | 各收藏夹的进度条 |
| `undo` | 撤销，把条目移回原本所在的收藏夹 |
| `move` | 手动移动单条，用于纠正个别误判 |
| `cleanup` | 删除本工具创建的、当前为空的收藏夹 |

常用参数：

```bash
node xhh.mjs apply --only 游戏推荐 --yes        # 只跑某一个夹
node xhh.mjs apply --limit 50 --yes            # 只跑 50 条（分批跑最安全）
node xhh.mjs apply --yes --throttle 2000       # 放慢到 2 秒一条
node xhh.mjs apply --yes --pause-every 100 --pause-ms 120000   # 每 100 条歇 2 分钟
node xhh.mjs undo --only 绘画同人 --yes         # 只撤销某个夹
node xhh.mjs move --link 123456 --to 壁纸 --yes # 手动把某条移到指定夹
```

## 分类规则

规则**按顺序匹配，先命中先用**，每条收藏只进一个夹，没命中的留在默认夹。

| 键 | 说明 |
| --- | --- |
| `keywords_any` | 标题 / 正文 / 话题 / 标签里包含任意一个词即命中 |
| `has_video` | `true` 只匹配带视频的 |
| `type_in` | 限定 `link_type` |
| `title_regex` | 标题正则 |

纯英文关键词**按词边界匹配**，所以 `ai` 不会误命中 `said`、`detail`。

写完跑 `plan`，除了看适配度自检，还要打开 **`data/plan.csv`** ——
第二列写着**每一条命中的是哪个关键词**，用 Excel 扫一眼就能看出哪个词归类错了：

```
folder,keyword,linkid,title
"游戏推荐","主机游戏",192059832,"jd塞尔达时之笛好价"
"绘画同人","同人绘画",191657430,"三一万能侠"
```

## 几个要注意的

- **`scan` 不能跳过。** 「全部收藏」列表里混着一些**已经在收藏夹里**的条目，
  不先扫描就会把它们从原夹里拽出来。`apply` 每次执行前也会自动重扫一遍。
- **会被限流。** 接口按出口 IP 封（403，连站点首页都一起 403），冷却数分钟起。
  脚本内置抖动、自适应降速、定期休息，连续被拦 5 次会主动收手并保存进度。
  全量几千条可能跑**数小时甚至跨天**，是「跑一阵、等一阵」的锯齿状，属正常。
  建议分批跨天跑：`--limit 800 --throttle 2000`。
- **撤销有前提。** 默认收藏夹原本是满的，要撤销回去得先腾出空间。
- **`apply` 默认预演**，不加 `--yes` 不会改任何东西。

## 更多文档

| 文档 | 内容 |
| --- | --- |
| [技术细节](docs/internals.md) | hkey 签名算法、完整接口表、踩过的坑、**降低风控风险** |
| [作为 Agent Skill 使用](docs/agent-skill.md) | 让 AI agent 自动按正确流程跑（含安装方法） |

## 赞赏

如果这个工具帮到了你，可以扫码请我喝杯咖啡 ☕

| 微信 | 支付宝 |
| :---: | :---: |
| <img src="assets/wechat-reward.png" alt="微信赞赏码" width="220"> | <img src="assets/alipay-reward.png" alt="支付宝赞赏码" width="220"> |

## 免责声明

本项目仅供学习与个人数据管理使用。它调用的是未公开的内部接口，**可能随时失效**，
也可能与小黑盒的用户协议存在冲突。请自行评估风险，并遵守目标站点的使用条款。
作者不对任何账号异常、数据丢失或封禁负责。
