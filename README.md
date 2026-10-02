# xiaoheihe-fav-organizer

[![赞赏 · 爱发电](https://img.shields.io/badge/%E8%B5%9E%E8%B5%8F-%E7%88%B1%E5%8F%91%E7%94%B5-ff69b4)](https://afdian.com/a/mervin1944) [![赞赏 · 微信](https://img.shields.io/badge/%E8%B5%9E%E8%B5%8F-%E5%BE%AE%E4%BF%A1-07C160?logo=wechat&logoColor=white)](assets/wechat-reward.png) [![赞赏 · 支付宝](https://img.shields.io/badge/%E8%B5%9E%E8%B5%8F-%E6%94%AF%E4%BB%98%E5%AE%9D-1677FF?logo=alipay&logoColor=white)](assets/alipay-reward.png)

> 把小黑盒（HeyBox）堆满的「默认收藏夹」按分类自动归入「收藏夹」的命令行工具。

小黑盒的收藏夹管理是 **App 独占功能**：网页端和 PC 客户端都只能看平铺列表，而默认收藏夹有容量上限，
攒满之后就没法再收藏了。这个工具直接调用后端接口，把堆积的收藏按关键词规则批量归档。

> **Unofficial tool.** Not affiliated with HeyBox / 小黑盒 / 清枫. It talks to HeyBox's
> internal, undocumented endpoints. Use at your own risk.

---

## 目录

- [它是怎么工作的](#它是怎么工作的)
- [快速开始](#快速开始)
- [命令](#命令)
- [分类规则](#分类规则)
- [接口逆向要点](#接口逆向要点)
- [已知限制与坑](#已知限制与坑)
- [降低风控风险](#降低风控风险)
- [作为 Agent Skill 使用](#作为-agent-skill-使用)
- [免责声明](#免责声明)

---

## 它是怎么工作的

小黑盒网页端是 SPA，收藏页只调了一个**只读**接口。建夹 / 移动 / 删夹这些写接口都没在前端出现，
是从 App 侧的接口族里逐个试探出来的，并且需要自己计算 `hkey` 签名才能调用。

脚本做的事：

1. 分页拉取「默认收藏夹」里的全部收藏
2. 按 `rules.json` 的关键词规则分类（标题 / 正文 / 话题 / 标签一起匹配）
3. 逐条调用移动接口归档，全过程带断点续跑和撤销记录

**不改动、不删除任何收藏内容**，只做「建夹」和「移动」。没命中规则的收藏留在默认夹里原样不动。

## 快速开始

需要 **Node.js 18+**（用到内置 `fetch`），无需 `npm install`。

```bash
git clone https://github.com/mervin1944/xiaoheihe-fav-organizer.git
cd xiaoheihe-fav-organizer
```

### 1. 配置 Cookie

浏览器打开 <https://xiaoheihe.cn/app/user/favour/content> 并确认已登录，然后：

1. `F12` → **Network / 网络** → `F5` 刷新
2. 筛选 `xiaoheihe`，点任意一条 `api.xiaoheihe.cn` 的请求
3. **Request Headers / 请求标头** 里找到 `Cookie:`，复制冒号后的整段值
4. 把 `cookie.txt.example` 复制成 `cookie.txt`，粘贴进去，保存

```bash
cp cookie.txt.example cookie.txt   # Windows: copy cookie.txt.example cookie.txt
```

> `cookie.txt` 等同登录凭证，已被 `.gitignore` 排除。泄露等于账号被接管，务必不要外发。

### 2. 看清自己的收藏构成

```bash
node xhh.mjs check      # 验证 cookie 并列出收藏夹
node xhh.mjs fetch      # 拉取全部收藏（最慢的一步，可中断续跑）
node xhh.mjs stats      # 打印 Top25 话题 / Top25 标签 —— 写规则前必看
```

`stats` 会打印出你的收藏里哪些主题/标签最多，例如：

```
话题 Top25:  盒友杂谈(2023)  碧蓝档案(2022)  Steam(775)  数码硬件(771)  动漫(413) …
标签 Top25:  蔚蓝档案(1410)  同人绘画(901)   steam游戏(559)  单机游戏(546) …
```

**拿这份数据决定分类**，而不是直接套用示例规则。见下方[分类规则](#分类规则)。

### 3. 写规则 → 出方案 → 执行

```bash
node xhh.mjs scan                                    # 扫描已有收藏夹（重要，见下）
node xhh.mjs plan                                    # 生成归类方案（只读，不动账号）
node xhh.mjs apply --only 碧蓝档案 --limit 20 --yes   # 先小批量试跑
node xhh.mjs status                                  # 查看进度
node xhh.mjs apply --yes                             # 全量执行
```

> **`scan` 不要跳过。** 「全部收藏」列表里其实混着一些**已经在收藏夹里**的条目，
> 不先扫描就会把用户已经整理好的内容从原夹里拽出来。
> `scan` 生成快照后，`plan` 会把这些条目排除；`apply` 每次执行前也会自动重扫一遍。

`plan` 跑完会输出一段**规则适配度自检**：

```
── 规则适配度自检 ──
  未归类占比  3.3%   （>30% 说明规则没抓住这个用户的主要兴趣）
  最大夹占比  16.7%  「职场生活」  （>50% 说明分类过粗，建议拆开）
  ✓ 看起来合理，可以进入人工审阅（看 data/plan.csv）
```

**超过阈值就说明规则不合适，别往下执行**，回去重新写规则。

**先试跑再全量**。`--limit 20` 只移 20 条，去 App 里确认效果无误后再跑全量。
`apply` 不带 `--yes` 是预演，不会改动账号。

## 命令

| 命令 | 说明 |
| --- | --- |
| `check` | 验证 cookie，列出收藏夹 |
| `folders` | 列出收藏夹及条数 |
| `fetch` | 分页拉取全部收藏 → `data/favourites.json`（可中断续跑） |
| `scan` | 扫描已有收藏夹内容 → `data/foldered.json`（`plan` 依赖它做保护） |
| `stats` | 打印收藏构成画像（Top25 话题 / Top25 标签），**写规则前必看** |
| `plan` | 生成归类方案 → `data/plan.json` / `plan.md` / `plan.csv`（只读） |
| `apply` | 建夹 + 移动，默认预演 |
| `status` | 各收藏夹的进度条 |
| `undo` | 撤销，把条目移回原本所在的收藏夹 |
| `move` | 手动移动单条，用于纠正个别误判 |
| `cleanup` | 删除本工具创建的、当前为空的收藏夹 |

常用参数：

```bash
node xhh.mjs apply --yes                       # 用保守默认值跑
node xhh.mjs apply --only 游戏推荐 --yes        # 只跑某一个夹
node xhh.mjs apply --limit 50 --yes            # 只跑 50 条（分批跑最安全）
node xhh.mjs apply --yes --throttle 2000       # 再放慢到 2 秒一条
node xhh.mjs apply --yes --pause-every 100 --pause-ms 120000   # 每 100 条歇 2 分钟
node xhh.mjs apply --yes --max-block 3         # 连续被拦 3 次就收手
node xhh.mjs apply --yes --no-scan             # 跳过安全检查（不建议）
node xhh.mjs undo --only 绘画同人 --yes         # 只撤销某个夹
node xhh.mjs move --link 123456 --to 壁纸 --yes # 手动把某条移到指定夹
node xhh.mjs fetch --restart                   # 丢弃已有数据重新拉取
```

## 分类规则

**`rules.json` 是你自己的文件，仓库不提供。** 仓库只给一份 `rules.example.json` 作语法参考 ——
那份是按一个「游戏 + 二次元」偏重的收藏调出来的，**直接套用几乎肯定不适合你**。

正确做法是**先看数据再写规则**：

```bash
node xhh.mjs stats      # 打印 Top25 话题 / Top25 标签
```

拿这些真实主题去决定要建哪些夹，然后照下面的格式写 `rules.json`：

```json
{
  "folders": [
    { "folder": "壁纸", "match": { "keywords_any": ["壁纸", "wallpaper"] } },
    { "folder": "视频", "match": { "has_video": true } }
  ]
}
```

只想先跑通看看效果，也可以直接复制示例：

```bash
cp rules.example.json rules.json     # Windows: copy rules.example.json rules.json
```

> 如果你是用 agent（如 DSH 的 `xiaoheihe-fav` skill）跑这个工具，
> skill 会强制它先跑 `stats`、把 Top 话题拿给你确认后再写规则 —— 而不是丢一份示例给你。

规则**按顺序匹配，先命中先用**，每条收藏只进一个夹。

`match` 支持的键：

| 键 | 说明 |
| --- | --- |
| `keywords_any` | 标题 / 正文 / 话题 / 标签里包含任意一个词即命中 |
| `has_video` | `true` 只匹配带视频的 |
| `type_in` | 限定 `link_type` |
| `title_regex` | 标题正则 |

纯英文关键词会**按词边界匹配**，所以 `ai` 不会误命中 `said`、`detail`。

写完规则后跑 `plan`，**必须看两样东西**：

1. **`plan` 输出的「规则适配度自检」** —— 未归类 >30% 或单个夹 >50% 就是 rule 没写对，回去改
2. **`data/plan.csv`** —— 第二列写着**每一条命中的是哪个关键词**，用 Excel 打开扫一眼，
   能直接看出哪个词归类错了

## 接口逆向要点

这部分是踩坑记录，供想自己写工具的人参考。

### 鉴权：Cookie + hkey 签名

两个条件缺一不可。缺 `hkey` 会返回 `{"status":"failed","msg":"hkey 不能为空"}`；
cookie 失效返回 `{"status":"login",...}`。

`hkey` 由「请求路径 + `_time` + `nonce`」混淆得出：

```
字符集 = "AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89"     (34 字符)
路径标准化 = "/" + 各段 + "/"                      (末尾补斜杠)
分量1 = 时间戳      按 字符集[0:-2] 逐字符映射 (charCode % len)
分量2 = 标准化路径  按 完整字符集 映射
分量3 = nonce       按 完整字符集 映射
交错  = 三者按下标轮流拼接 (k=0: c1[0]c2[0]c3[0]; k=1: ...)
md5   = md5(交错串[:20])
前缀  = md5[:5] 按 字符集[0:-4] 映射
后缀  = (对 md5[-6:] 的字符码做一轮异或混淆后求和) % 100，补足两位
hkey  = 前缀 + 后缀
```

实现见 `xhhlib.mjs` 的 `getHkey()`。

### 接口一览

| 操作 | 请求 | 参数 |
| --- | --- | --- |
| 列全部收藏夹 | `GET /bbs/app/profile/fav/folders` | — |
| 列全部收藏 | `GET /bbs/app/profile/fav/folder/v2/links` | `enable_new_style_collect=1&offset&limit` |
| 列某个夹内容 | `GET /bbs/app/profile/fav/folder/links` | `folder_id&offset&limit` |
| 新建收藏夹 | `POST /bbs/app/profile/fav/folder/add` | 表单体 `name` |
| 移动一条收藏 | `POST /bbs/app/profile/fav/folder/move` | 表单体 `folder_id` + `link_id` |
| 删除收藏夹 | `POST /bbs/app/profile/fav/folder/del` | 表单体 `folder_id` |

所有请求还需要一组固定的 web 端通用参数（`os_type=web`、`app=heybox`、`client_type=web` 等），
见 `xhhlib.mjs` 的 `COMMON`。

两个补充细节：

- 列某个夹内容时，服务端**硬性每页最多 30 条**，`limit` 传 100/200 都只返回 30，
  必须用 `offset` 翻页；返回体里的 `result.folder.count` 是总数，可作为终止依据。
- 列全部收藏（`v2/links`）没有总数，且 `has_next` 不会变成 `"0"`，见下方「坑」一节。

## 已知限制与坑

- **「全部收藏」列表里混着已归档的条目**。这是最容易踩的坑：列表并非只含默认夹里的内容，
  有些条目其实已经在某个收藏夹里了。直接按列表移动会把用户已经整理好的内容**从原夹里拽出来**。
  所以务必先 `scan`，让 `plan` 排除它们；`apply` 也会在执行前重扫一遍，
  并对这类条目跳过（记为「跳过:原在 X」）。
- **写接口的参数必须放在 POST 表单体里**。放 query string 会被静默忽略，
  报「请输入收藏夹名」/「要移动的帖子不存在」这类误导性错误。
- **一次只能移一条**。重复传 `link_id` 参数只会生效第一个，没有可用的批量接口。
- **分页不会自己结束**。`has_next` 永远是 `"1"`，扫描超过真实末尾后会**循环返回重复数据**。
  正确做法是按 `linkid` 去重，并以「连续若干页无新增」作为终止条件。
- **限流很明显**。高频请求会返回 openresty `403 Forbidden`，而且是**按出口 IP 封**的
  （连站点首页都会一起 403），冷却时间数分钟起。脚本内置指数退避 + 自适应降速，
  全量跑几千条会是「跑一阵、等一阵」的锯齿状，属正常。
- **夹名与数量上限**：夹名实测 16 字符可用、20 字符被拒；数量连续创建 30 个未撞上限。
  （网上 2024 年的旧帖说「最多 9 个夹、名字最多 8 字符」，已经不准确了。）
- **默认收藏夹（`folder_id=0`）满了之后**，往里移动会报「目标收藏夹容量不够」。
  所以撤销时如果默认夹已满，需要先移出足够的条数腾出空间。
- **失效条目**：已被删除的收藏会以 `is_deleted=1`、空标题、`link_type=0` 返回，脚本会自动跳过。

## 降低风控风险

先说清楚风险到底是什么：

| 风险 | 实测情况 | 严重程度 |
| --- | --- | --- |
| **出口 IP 被限流** | 已复现。高频请求后 `403 Forbidden`，连站点首页都一起 403，冷却数分钟起 | 高，但可恢复 |
| **账号被风控** | 未观察到。调用的是 App 同款接口，签名/参数一致 | 未知，无法保证 |

**先说个坏消息：没有批量接口。** 实测 `multi_move`、`batch_move`、`move_out`、`move_links`
等十余个候选路由全部 404，一次请求只能移一条。所以请求总数省不掉
（N 条收藏 = N 次请求），能优化的只有**速率和请求模式**。

### 脚本内置的措施

- **请求间隔加抖动**（0.6×–1.4× 随机），固定节奏是很明显的机器人特征
- **自适应降速**：被限流后间隔自动 +200ms，上限 4 秒；退避时间同样带 ±20% 抖动
- **定期休息**：默认每 200 条歇 60 秒，模拟人工分批操作
- **连续被拦就收手**：默认连续 5 次 403 即主动中止本次运行并保存进度 ——
  继续硬撞只会延长封禁。等 30 分钟或换网络出口后重跑同一命令即可续上
- **保守默认值**：间隔从 450ms 提到 1000ms
- **全程串行**，绝不并发请求

### 你能做的（比调参数更有效）

1. **用你自己的家宽 IP，别用共享的机场/VPN 出口。** 之前那次封禁封的就是代理出口 IP ——
   共享出口上别人的行为会算到你头上，而且你也不知道同 IP 上还有谁在刷。
2. **分批跑，跨天完成。** 与其一口气跑 8000 条，不如每天 `--limit 1000`，跑一周。
   这是降低"行为异常"最有效的手段。
3. **别在跑的时候同时用 App 刷收藏。** 同一账号短时间内多个"设备"活跃是异常信号。
4. **避开凌晨。** 连续几小时凌晨 3 点的高频写入，比白天更容易被打上标记。
5. **不要并行开多个终端跑。** 脚本内部已经串行 + 限速，多开只会成倍放大速率。

### 保守档参考命令

```bash
# 每天一段，跑完就停
node xhh.mjs apply --yes --limit 800 --throttle 2000 --pause-every 100 --pause-ms 120000 --max-block 3
```

按这个节奏，8000 条约需 10 天。慢，但这是最不容易出事的做法。

> **免责**：以上是对已观测现象的处理，不是对账号安全的保证。风控策略由对方掌握且不公开，
> 无法承诺"一定不封"。请自行判断是否值得。

## 作为 Agent Skill 使用

`skill/SKILL.md` 是一份 Agent Skill 描述文件。它**不替代脚本** —— 脚本是引擎，skill 是操作纪律：
把「必须先 `scan` 再 `plan`」「`apply` 默认预演」「执行前必须让用户审方案」
「限流与耗时预期」这些约束固化下来，让 agent 每次都不会绕过去。

安装到用户级 skill 目录（对所有项目生效）：

```bash
# macOS / Linux
mkdir -p ~/.dsh/skills
cp -r skill ~/.dsh/skills/xiaoheihe-fav
```

```powershell
# Windows
xcopy /E /I skill "$env:USERPROFILE\.dsh\skills\xiaoheihe-fav"
```

装好后 skill 目录会被监听，**无需重启**即可进入会话目录。之后直接说
「帮我把小黑盒收藏整理一下」就能触发。

skill 不硬编码脚本路径：它会依次尝试环境变量 `XHH_FAV_DIR`、`glob` 搜 `**/xhh.mjs`、
最后问用户。因此同一个文件在本地和仓库里完全一致 —— 但**更新脚本后请重新复制一次** `skill/`。

## 赞赏

如果这个工具帮到了你，可以扫码请我喝杯咖啡 ☕

| 微信 | 支付宝 |
| :---: | :---: |
| <img src="assets/wechat-reward.png" alt="微信赞赏码" width="220"> | <img src="assets/alipay-reward.png" alt="支付宝赞赏码" width="220"> |

## 免责声明

本项目仅供学习与个人数据管理使用。它调用的是未公开的内部接口，**可能随时失效**，
也可能与小黑盒的用户协议存在冲突。请自行评估风险，并遵守目标站点的使用条款。
作者不对任何账号异常、数据丢失或封禁负责。
