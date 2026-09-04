# AI对话管理器

Microsoft Edge 浏览器扩展（Manifest V3），用于统一管理国内 5 大 AI 对话平台的历史对话。

## 支持平台

| 平台 | 状态 |
|------|------|
| DeepSeek | ✅ 官方 API（content script，无页面 Hook） |
| 豆包 | ✅ data-testid 结构化提取 |
| 通义千问 | ✅ Web API（content script，无页面 Hook） |
| 腾讯元宝 | 🔧 基础适配器 |
| Kimi | 🔧 基础适配器 |

## 安装（开发者模式）

### 1. 生成图标

```powershell
cd icons
.\generate-icons.ps1
```

或在浏览器中打开 `icons/generate-icons.html`，点击下载全部图标。

### 2. 加载扩展到 Edge

1. 打开 Edge，访问 `edge://extensions/`
2. 开启左下角「开发人员模式」
3. 点击「加载解压缩的扩展」
4. 选择 `ai-chat-manager` 文件夹

### 3. 使用

1. 访问 [DeepSeek Chat](https://chat.deepseek.com/) 并完成一段对话
2. 点击扩展图标打开侧边栏
3. 点击「💾 保存本轮」保存对话
4. 在列表中点击对话查看详情、复制或删除

## 项目结构

```
ai-chat-manager/
├── manifest.json          # MV3 配置
├── background/            # Service Worker
├── content/               # Content Scripts + 平台适配器
├── sidepanel/             # 侧边栏 UI
├── lib/                   # 存储、Markdown、导出
├── utils/                 # 工具函数
└── icons/                 # 扩展图标
```

## 开发阶段

- **P0**: 框架 + DeepSeek API
- **P1 (当前)**: 豆包 + 通义千问正式接入
- **P2**: 元宝 / Kimi + 导出增强
- **P3**: 飞书 API + 跨设备同步

## 隐私

所有数据存储在本地 `chrome.storage.local`，不会上传到任何服务器。
