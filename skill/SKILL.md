---
name: xiaoheihe-fav
description: Use when the user wants to inspect, classify, or bulk-organize their 小黑盒 / HeyBox favourites (收藏) into collection folders (收藏夹) — including first-time setup, generating a classification plan, running the migration, checking progress, or undoing it.
whenToUse: The user mentions 小黑盒 / HeyBox 收藏 being full, wants favourites sorted into 收藏夹, or asks about the state of a previous organization run.
---

# 小黑盒收藏整理

把「默认收藏夹」里堆积的收藏按规则批量归入自定义收藏夹。

## 先定位工具目录

所有命令都在工具目录里执行。按顺序尝试：

1. 如果环境变量 `XHH_FAV_DIR` 已设置，用它。
2. 用 `glob` 搜 `**/xhh.mjs`（或 `**/xiaoheihe-fav-organizer/xhh.mjs`）。
3. 以上都找不到，**直接问用户**要路径。

找到后先 `cd` 过去。**绝不要**在别处重写一份脚本 —— hkey 签名、POST 表单体、
分页循环重复数据这些坑都已处理，另起炉灶只会重新踩一遍。

## 前置条件

- Node.js **18+**（只用内建 `fetch`，零依赖，不需要 `npm install`）
- `cookie.txt` 必须已配置。首次使用引导用户：把 `cookie.txt.example` 复制为 `cookie.txt`，
  再从浏览器 F12 → Network → 任一 `api.xiaoheihe.cn` 请求的 Request Headers 里复制整行 Cookie 粘贴进去。

> **安全红线**：绝不要让用户把 Cookie 粘进对话，也不要主动去读浏览器的 Cookie 数据库。
> Cookie 等同账号登录态，只能由用户自己写进 `cookie.txt`。

## 标准流程

```bash
node xhh.mjs check     # 验证 cookie，确认能跑通
node xhh.mjs scan      # 扫描已有收藏夹，生成保护快照
node xhh.mjs plan      # 生成归类方案（只读，不动账号）
node xhh.mjs apply --yes            # 执行（默认预演，--yes 才真正写）
node xhh.mjs status    # 查看进度
node xhh.mjs undo --yes             # 撤销
```

`fetch` 只在需要重新拉取收藏时用，很慢，见下。

## 硬性约束 —— 不要绕过

1. **必须先 `scan` 再 `plan`。** 「全部收藏」列表里混着已经在收藏夹里的条目，
   不先扫描就会把用户已经手工整理好的内容从原夹里拽出来。`apply` 每次执行前会自动重扫，
   但 `plan` 的预览数字要靠 `scan` 才准确。

2. **`apply` 默认是预演。** 不带 `--yes` 绝不写入。**永远不要**在没有让用户过一遍方案的情况下
   直接加 `--yes` 全量执行 —— 那是几千到上万条写操作。

3. **执行前必须让用户审方案。** `plan` 会生成 `data/plan.csv`，第二列是每条命中的关键词。
   指导用户用它核对分类是否符合预期；规则在 `rules.json`，改完重新 `plan` 即可。
   仓库自带的规则是对「游戏 + 二次元」偏重的收藏调的示例，**不一定适合该用户**。

4. **先小批量试跑。** 首次执行用 `--limit 20`，让用户去 App 里确认效果，再全量。

5. **提前说明耗时与限流。** 接口按出口 IP 限流（403，连站点首页都会一起 403）。
   **没有批量接口** —— 十几个候选路由实测全部 404，一次只能移一条，
   所以 N 条收藏就是 N 次请求，请求数省不掉。脚本内置抖动、自适应降速、定期休息，
   并在**连续被拦 5 次后主动中止**（这是设计行为，不是 bug，进度已保存）。
   全程可能持续数小时甚至跨天，用后台作业跑，别在前台等。

   推荐引导用户**分批跨天**而不是一口气跑完 —— 这是降低行为异常最有效的手段：

   ```bash
   node xhh.mjs apply --yes --limit 800 --throttle 2000 --pause-every 100 --pause-ms 120000 --max-block 3
   ```

   另外提醒：在共享 VPN/机场出口上跑风险更高（别人在同 IP 上的行为会算进来），
   用自己家宽 IP 更安全；也别在跑的时候同时用 App 刷收藏。

6. **不要自己写临时脚本调接口。** hkey 签名、参数放在 POST 表单体、分页会循环重复数据
   这些坑都已经在 `xhhlib.mjs` 里处理好了，另起炉灶只会重新踩一遍。

## 排查

| 现象 | 处理 |
|---|---|
| `hkey 不能为空` / 参数类报错 | 正常不会出现；说明在用自己拼的请求，回到 CLI |
| `cookie 无效或已过期` | 让用户重新复制 Cookie 覆盖 `cookie.txt` |
| 持续 403，连站点首页都打不开 | 出口 IP 被限流，换代理节点或等冷却，别继续打 |
| `目标收藏夹容量不够` | 默认收藏夹满了；移出足够条数后再撤销回来 |
| 想手工纠正个别误判 | `node xhh.mjs move --link <id> --to <夹名> --yes` |

## 完成后

提醒用户：`data/`（收藏数据 + 移动记录）和 `cookie.txt` 都含个人隐私，**已被 `.gitignore` 排除**，
不要用 `git add -f` 强行提交，也不要外发。
