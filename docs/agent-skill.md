# 作为 Agent Skill 使用

`skill/SKILL.md` 是一份 Agent Skill 描述文件。

**它不替代脚本** —— 脚本是引擎，skill 是**操作纪律**：把「必须先 `scan` 再 `plan`」
「配规则前先看清收藏构成」「`apply` 默认预演」「执行前必须让用户审方案」
「限流与耗时预期」这些约束固化下来，让 agent 每次都不会绕过去。

## 安装

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

## 它固化了哪些约束

| 约束 | 不遵守的后果 |
| --- | --- |
| 配规则前先跑 `stats`、拿真实数据问用户想怎么分 | 套用示例规则，得到一堆未归类和几个莫名其妙的夹 |
| 必须先 `scan` 再 `plan` | 把用户已手工整理的内容从原收藏夹里拽出来 |
| `apply` 默认预演，`--yes` 才写 | 误操作上万个条目 |
| 执行前让用户审 `plan.csv` | 按错规则归档，回滚要一小时 |
| 先 `--limit 20` 试跑 | 发现问题时已经移了几千条 |
| 提前说明限流与数小时耗时 | 用户以为卡死了 |
| 不要自己写临时脚本调接口 | 重新踩一遍 hkey / 表单体 / 分页的坑 |

## 两个注意点

**不硬编码路径。** skill 会依次尝试环境变量 `XHH_FAV_DIR`、`glob` 搜 `**/xhh.mjs`、
最后问用户。所以本地安装的那份和仓库里这份**完全一致**。

**更新脚本后要重新复制。** 因为上面这条设计，skill 与脚本没有版本绑定 ——
改了 `skill/SKILL.md` 之后记得重新执行一次安装命令。

> 脚本本身也带护栏（`stats` 的下一步提示、`plan` 的规则适配度自检、`apply` 的复查提醒），
> 所以**不装 skill、纯手工敲命令也有保护**。skill 的价值是让 agent 不能绕过这些步骤。
