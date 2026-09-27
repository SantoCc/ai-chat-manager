# AI对话管理器

Microsoft Edge 扩展（Manifest V3）：把豆包、通义千问、DeepSeek、腾讯元宝、Kimi 的对话统一保存到侧栏，支持整理、搜索、导出。数据默认只存在本机。

**商店安装（推荐）** · [落地页](https://santocc.github.io/ai-chat-manager/) · [隐私政策](https://santocc.github.io/ai-chat-manager/privacy.html) · [提交体验反馈](https://github.com/SantoCc/ai-chat-manager/issues/new?template=feedback.yml)

---

## 安装

### 方式 A：Edge 扩展商店（给使用者）

1. 打开 [Microsoft Edge Add-ons · AI对话管理器](https://microsoftedge.microsoft.com/addons/detail/jfhbkeaapcnbjiicekkkleinfnjkpjoj)
2. 点击 **获取**
3. 在任意支持的 AI 站点打开对话 → 点扩展图标打开侧栏 → 保存

也可在 Edge 商店搜索：**AI对话管理器**。

更完整的一屏说明（含截图）：https://santocc.github.io/ai-chat-manager/

### 方式 B：开发者模式（给开发 / 尝鲜）

1. 克隆本仓库
2. Edge 打开 `edge://extensions/` → 开启「开发人员模式」
3. 「加载解压缩的扩展」→ 选择本仓库根目录（含 `manifest.json`）
4. 访问支持的 AI 站点，用侧栏保存对话

若缺少图标，可先进入 `icons/` 运行 `generate-icons.ps1`，或打开 `icons/generate-icons.html` 生成。

---

## 支持平台

| 平台 | 状态 |
|------|------|
| DeepSeek | ✅ |
| 豆包 | ✅ |
| 通义千问 | ✅ |
| 腾讯元宝 | 🔧 基础适配 |
| Kimi | 🔧 基础适配 |

---

## 体验反馈

装上后卡在哪、缺什么功能，请用模板开 Issue（比私信更好追踪）：

→ [填写体验反馈](https://github.com/SantoCc/ai-chat-manager/issues/new?template=feedback.yml)

也可直接评论相关帖子 / 私信，但 Issue 优先。

---

## 项目结构

```
ai-chat-manager/
├── manifest.json          # MV3 配置
├── background/            # Service Worker
├── content/               # Content Scripts + 平台适配器
├── sidepanel/             # 侧栏 UI
├── lib/                   # 存储、Markdown、导出
├── utils/                 # 工具函数
├── docs/                  # GitHub Pages（落地页 / 隐私政策）
├── _locales/              # 商店多语言
└── icons/                 # 扩展图标
```

---

## 隐私

对话内容默认保存在浏览器本地（`chrome.storage.local`），不上传到开发者自建服务器。详见 [隐私政策](https://santocc.github.io/ai-chat-manager/privacy.html)。

---

## License

见 [LICENSE](./LICENSE)。