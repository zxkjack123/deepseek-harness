---
kind: upgrade-guide
description: "Web 应用默认把已认证的启动 URL 写入 $DSH_HOME/web-url.txt，等于把进程 token 落到磁盘。"
---

# Web 应用会记录已认证的启动 URL

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-web-app` 新增 `launchUrlFile?: string | false`。未配置时，它把已认证的启动 URL 写入 `$DSH_HOME/web-url.txt`；文件以 `0o600` 建立在 `0o700` 目录中，每次启动替换。`false` 不写文件，字符串则指定其他路径。

被写入的 URL 内含授权访问该运行实例的进程 token，因此这个文件属于凭据，不是书签。

## 迁移

- 在不得把 token 落盘的组合上设置 `launchUrlFile: false`，例如共享主机、容器镜像与 CI。
- 把 `$DSH_HOME/web-url.txt` 当作机密材料：不要进入镜像、日志、备份与文本记录。
- 上一个进程留下的文件没有用处：token 属于写入它的那个进程，过期文件只会认证失败，不会放行。
