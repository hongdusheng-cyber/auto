# 办公自动化工作台

## 启动要求

- Node.js 20 或更高版本（推荐 Node.js 24 LTS）
- npm
- 可视化桌面环境

## 安装并启动

在终端执行：

```sh
git clone https://github.com/hongdusheng-cyber/auto.git
cd auto
npm ci
npx playwright install chromium
npm run ui
```

然后打开：

<http://localhost:17321>

工作台运行期间请保持终端窗口开启。按 `Ctrl+C` 可停止服务。

## macOS 快速启动

完成一次依赖安装后，可以直接双击项目目录中的：

```text
run-control-panel.command
```

如果无法双击运行，请在终端执行：

```sh
chmod +x run-control-panel.command
```

也可以始终使用 `npm run ui` 启动。

## 修改端口

默认端口是 `17321`。端口被占用时，可使用其他端口启动：

macOS / Linux：

```sh
PORT=17322 npm run ui
```

Windows PowerShell：

```powershell
$env:PORT = "17322"
npm run ui
```

然后打开 <http://localhost:17322>。
