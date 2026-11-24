# agy-hud

面向 **Antigravity CLI（`agy`）** 的双行实时状态栏插件，零第三方依赖，安装 Node.js 18+ 即可使用。

## 效果示例

```text
[Gemini 4 Neon ◕ High]  my-project git:(main*)  │  ██░░░░░░ 24% (240k/1M)  │  68.4 tok/s
Gemini  5h ██░░░░░░ 29% (1h24m) · 周 8% (6d20h)  │  3P 0%  │  Argon 0%
```

- **第一行**：当前模型与推理强度、工作目录与 Git 状态、上下文占用进度条、模型输出速度（`tok/s`）及子代理数量。
- **第二行**：各模型池 5 小时与每周配额耗用、重置倒计时及积分余额；通过官方只读命令每 45 秒后台刷新，不消耗对话配额，窄屏自动切换紧凑显示。

## 安装使用

1. 克隆到 Antigravity CLI 配置目录并添加执行权限：

```bash
git clone https://github.com/richardu8/agy-hud.git ~/.gemini/antigravity-cli/agy-hud
chmod +x ~/.gemini/antigravity-cli/agy-hud/hud.mjs ~/.gemini/antigravity-cli/agy-hud/refresh-usage.mjs
```

2. 在 `~/.gemini/antigravity-cli/settings.json` 中加入 `statusLine` 配置：

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.gemini/antigravity-cli/agy-hud/hud.mjs",
    "enabled": true,
    "stack_with_default": true
  }
}
```

> 若终端环境找不到 `node`，可将 `command` 改为带绝对路径的写法（如 `/opt/homebrew/bin/node ~/.gemini/antigravity-cli/agy-hud/hud.mjs`）。

## 致谢

本项目的状态栏布局与配色风格深受 [`claude-hud`](https://github.com/jarrodwatts/claude-hud) 启发，特此感谢 `claude-hud` 作者 [Jarrod Watts](https://github.com/jarrodwatts)。

## 开源协议

基于 [MIT 协议](./LICENSE) 开源。
