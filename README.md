# xiaoheihe-fav-organizer

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

### 2. 跑起来

```bash
node xhh.mjs check                                   # 验证 cookie 并列出收藏夹
node xhh.mjs fetch                                   # 拉取全部收藏（可中断续跑）
node xhh.mjs plan                                    # 生成归类方案（只读，不动账号）
node xhh.mjs apply --only 碧蓝档案 --limit 20 --yes   # 先小批量试跑
node xhh.mjs status                                  # 查看进度
node xhh.mjs apply --yes                             # 全量执行
```

**先试跑再全量**。`--limit 20` 只移 20 条，去 App 里确认效果无误后再跑全量。
`apply` 不带 `--yes` 是预演，不会改动账号。

## 命令

| 命令 | 说明 |
| --- | --- |
| `check` | 验证 cookie，列出收藏夹 |
| `folders` | 列出收藏夹及条数 |
| `fetch` | 分页拉取全部收藏 → `data/favourites.json`（可中断续跑） |
| `stats` | 统计内容类型、话题分布 |
| `plan` | 生成归类方案 → `data/plan.json` / `plan.md` / `plan.csv`（只读） |
| `apply` | 建夹 + 移动，默认预演 |
| `status` | 各收藏夹的进度条 |
| `undo` | 撤销，把条目移回原本所在的收藏夹 |
| `cleanup` | 删除本工具创建的、当前为空的收藏夹 |

常用参数：

```bash
node xhh.mjs apply --yes --throttle 800       # 放慢到 800ms，更不容易被限流
node xhh.mjs apply --only 游戏推荐 --yes       # 只跑某一个夹
node xhh.mjs apply --limit 50 --yes           # 只跑 50 条
node xhh.mjs undo --only 绘画同人 --yes        # 只撤销某个夹
node xhh.mjs fetch --restart                  # 丢弃已有数据重新拉取
```

## 分类规则

规则在 `rules.json`，**按顺序匹配，先命中先用**，每条收藏只进一个夹。

```json
{
  "folders": [
    { "folder": "壁纸", "match": { "keywords_any": ["壁纸", "wallpaper"] } },
    { "folder": "视频", "match": { "has_video": true } }
  ]
}
```

`match` 支持的键：

| 键 | 说明 |
| --- | --- |
| `keywords_any` | 标题 / 正文 / 话题 / 标签里包含任意一个词即命中 |
| `has_video` | `true` 只匹配带视频的 |
| `type_in` | 限定 `link_type` |
| `title_regex` | 标题正则 |

纯英文关键词会**按词边界匹配**，所以 `ai` 不会误命中 `said`、`detail`。

> 仓库自带的 `rules.json` 是一个针对「游戏 + 二次元」内容偏重的收藏夹调出来的示例，
> 不一定适合你。**务必先 `plan`，然后用 Excel 打开 `data/plan.csv` 扫一眼**——
> 里面第二列写着每一条命中的是哪个关键词，能直接看出规则是否合理。改完重新 `plan` 即可。

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

## 已知限制与坑

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

## 免责声明

本项目仅供学习与个人数据管理使用。它调用的是未公开的内部接口，**可能随时失效**，
也可能与小黑盒的用户协议存在冲突。请自行评估风险，并遵守目标站点的使用条款。
作者不对任何账号异常、数据丢失或封禁负责。
