# 办公自动化工作台

基于 Node.js 和 Playwright 的本地网页工作台，用于在 OSASE 后台完成客户创建、网络加速、流量规则、合约开通及 CPE 设备操作。推荐通过网页操作，也可以单独运行命令行脚本。

**使用者需要自己的 OSASE 管理员账号及相应业务权限。** 下载项目即可安装，无需安装 Codex，也不包含作者的登录状态。业务脚本会打开可见浏览器，因此需要有桌面环境的电脑。

## 1. 安装前准备

| 项目 | 要求 |
| --- | --- |
| Node.js | 推荐 [Node.js 24 LTS](https://nodejs.org/)，依赖最低要求 Node.js 20；使用包含 npm 的官方安装包 |
| Git | 使用 `git clone` 下载时需要；也可以在 GitHub 点击 **Code → Download ZIP** 并解压 |
| 浏览器 | 推荐安装 [Google Chrome](https://www.google.com/chrome/)；下方还会安装 Playwright Chromium 作为备用浏览器 |
| 网络与账号 | 能访问 `console.osase.net`、`api.osase.net` 及组织的 Logto 登录服务，并有目标公司、合约和设备的操作权限 |
| 系统 | 提供 macOS 双击启动脚本；Windows / Linux 使用终端启动。当前验证环境为 macOS，其他系统尚未完成整套验证 |

安装 Node.js 后，重新打开终端，确认这两个命令都能显示版本：

```sh
node --version
npm --version
```

## 2. 下载、安装和启动

在终端逐行执行：

```sh
git clone https://github.com/hongdusheng-cyber/auto.git
cd auto
npm ci
npx playwright install chromium
npm run ui
```

如果下载的是 ZIP，请先解压，再在含有 `package.json` 的目录打开终端，从 `npm ci` 开始执行。所有后续命令也在此目录执行。

看到 `本地控制台已启动：http://localhost:17321` 后，打开：

**<http://localhost:17321>**

macOS 会尝试自动打开网页；Windows / Linux 请手动打开上述地址。保持终端运行，在终端按 **Ctrl+C** 可停止工作台及其启动的任务。不要直接双击 `web/control-panel.html`，网页需要本地服务才能运行。

Linux 如果提示缺少浏览器系统依赖，可按 Playwright 提示执行以下命令（可能需要系统管理员权限），并确保运行于图形桌面会话：

```sh
npx playwright install --with-deps chromium
```

### macOS 后续双击启动

首次完成依赖安装后，可以双击 `run-control-panel.command` 或 `mac-control-panel.command`。这两个文件只负责启动，不会自动安装 Node.js、npm 包或浏览器。

如果提示没有执行权限，在项目目录执行：

```sh
chmod +x run-control-panel.command mac-control-panel.command
```

也可以始终使用 `npm run ui` 启动。

## 3. 首次登录与试运行

启动工作台只会打开本地界面。执行需要访问后台的任务时，才会打开自动化浏览器并进入登录流程。

建议先完成一次**只填写表单、不提交**的试运行：

1. 使用 UTF-8 编码的文本文件保存一份客户资料，格式见下一节；将命令中的文件路径替换为自己的路径。
2. 执行下面的命令，不加 `--submit`，并确认当前终端未设置 `SUBMIT=true`。
3. 在脚本打开的浏览器里完成自己的管理员登录。脚本会尝试点击“使用 Logto 登录”和“登录”；账号、密码及验证码由使用者填写。
4. 登录后，检查脚本填写的“添加用户”表单。此命令不会点击最终提交按钮，检查完关闭浏览器，必要时按 Ctrl+C 结束命令。

```sh
npm run add:user -- --file examples/customer.txt
```

这里的 `examples/customer.txt` 仅用于验证格式和表单填写，实际业务请换成自己的资料。若只想验证资料解析、不打开浏览器，执行：

```sh
npm run add:user -- --file examples/customer.txt --dry-run-parse
npm run network:acceleration -- --file examples/customer.txt --dry-run-parse
```

首次登录成功后，登录状态会保存在本机，后续任务可复用。普通 Chrome 窗口里的登录状态不会自动共享给本项目。登录过期时，在脚本打开的窗口重新认证即可。

## 4. 网页使用教程

### 填写客户资料

将以下格式粘贴到“客户开通 → 客户资料”，并替换为实际内容：

```text
公司名称：示例科技有限公司
应用场景：英国 10M 家宽IP TikTok直播 香港出口
邮箱：customer@example.com
部署方式：CPE设备
```

添加用户需要公司名称和邮箱；网络加速需要公司名称，以及能识别地区和带宽的应用场景，例如 `美国 5M`、`香港 10M`。针对已存在的公司操作时，使用后台登记的完整公司名称。

### 选择业务流程

**网页上的业务按钮会执行实际提交。** 请核对公司、地区、带宽、规则及设备信息后再点击；下表中的组合流程不会自动执行“添加用户”。新客户应先单独添加用户，已有客户可直接进入相应流程。

| 操作 | 需要准备 | 实际执行内容 |
| --- | --- | --- |
| 添加用户 | 公司名称、邮箱等客户资料 | 创建客户并执行脚本中的代理商设置步骤；成功后显示账号和密码 |
| 网络加速 | 已存在的公司、地区、带宽 | 创建网络加速服务 |
| 网络加速 + 流量规则 | 客户资料、勾选的规则 | 创建网络加速 → 获取本次服务 ID → 添加规则；不需要 IP 参数 |
| 加速 + 合约 | 客户资料、IP 参数 | 创建网络加速 → 获取本次服务 ID → 开通合约并配置出口 |
| 完成开通、合约与规则 | 客户资料、规则、IP 参数 | 创建网络加速 → 获取本次服务 ID → 添加规则 → 开通合约并配置出口 |

新客户的一次典型开通操作：

1. 填写客户资料，点击“添加用户”，确认后台已创建成功并保存返回的账号信息。
2. 在“流量规则”中勾选需要的规则。可展开“管理规则按钮”保存常用组合，应用名称以后台实际名称为准。
3. 若需要开通合约，在“合约与出口”中填写 IP 参数。
4. 按需点击“网络加速 + 流量规则”或“完成开通、合约与规则”。组合流程会自动传递本次新建服务 ID。
5. 查看“运行控制台”的步骤与结果，再到后台核对服务、规则和合约状态。

如果组合流程在中途失败，先检查已经完成的步骤。网络加速已经创建时，应使用已有服务 ID 补加规则或开通合约，避免再次点击创建流程而重复开通。

### 合约与出口

处理已有合约时，填写对应的“合约 ID”和“IP 参数”，再点击“开通合约并配置出口”。代理参数格式为：

```text
服务器:端口:用户名:密码
proxy.example.com:62001:your-proxy-username:your-proxy-password
```

域名、IPv4 和使用方括号包裹的 IPv6 均可作为服务器地址；端口须为 1–65535。示例中的账号和密码是占位值，必须替换。

“生成 Magic 配置”只根据参数生成本地配置，不会开通后台合约；可以用“复制配置”手动粘贴。生成结果保存在 `.control-panel/magic-config-latest.txt`，按合约生成时还会保存对应 ID 的副本。

### 流量规则与完善规程

- **添加选中规则**：填写公司名称、已有网络加速服务 ID，并勾选应用规则。公司名称留空时从上方客户资料读取。
- **完善规程**：填写公司名称并选择规则，向该公司的“隐藏规则包设置”添加规则包，不需要服务 ID。它与“流量规则”共用规则按钮和勾选状态。

### 设备运维

填写公司完整名称、设备名称和设备 MAC，然后按需选择“接管并升级设备”或“出库后接管并升级”。这些是组合操作，确认设备归属和后台可用状态后再执行。

### 查看进度与停止

页面下方显示每个任务及子步骤的日志；默认最多同时运行 8 个任务，仍保持打开的任务浏览器也可能占用槽位。可以关闭完成的任务浏览器或点击“停止全部”。停止任务不会撤销后台已经完成的操作。

## 5. 命令行使用

日常操作推荐网页。命令行参数必须放在 `npm run 命令 --` 后面。以下公司名、邮箱、ID、代理和 MAC 均为示例，正式操作前替换。

### 添加用户、成员账号和网络加速

这三类命令默认只填写表单；加 `--submit` 才提交。添加用户和网络加速也会读取 `SUBMIT=true` 环境变量，不要在试运行终端中启用它。

```sh
npm run add:user -- --file examples/customer.txt --submit
npm run add:account -- --company "示例科技有限公司" --name "张三" --email "member@example.com" --submit
npm run network:acceleration -- --file examples/customer.txt --submit
```

“添加账号”是为**已有公司新增成员**，不同于“添加用户”创建客户。当前网页中的添加账号区域处于隐藏状态，请使用上面的命令行入口。姓名可写作 `张三`、`欧阳明`，也可以用空格分隔姓与名。脚本自动生成密码和手机号，成功后在终端返回账号结果；手机号重复时停止并提示。

### 规则、合约和设备

下面的命令会操作后台，不需要另加 `--submit`。若只检查参数，请在对应命令末尾加 `--dry-run-parse`，此模式不打开浏览器。

```sh
npm run rules:add -- --company "示例科技有限公司" --service-id 12345 --rules "office365,TikTok跨境电商"
npm run rules:complete -- --company "示例科技有限公司" --rules "Google,office365"
npm run contract:open -- --contract-id 12345 --ip "proxy.example.com:62001:your-proxy-username:your-proxy-password"
npm run sdwan:takeover -- --company "示例科技有限公司" --device-name "示例公司-CPE01" --device-mac "02:00:00:00:00:01"
npm run device:upgrade -- --device-mac "02:00:00:00:00:01"
npm run device:warehouse-outbound -- --company "示例科技有限公司" --device-name "示例公司-CPE01" --device-mac "02:00:00:00:00:01"
```

设备命令行入口分别处理接管、升级、出库；网页按钮负责串联这些步骤。直接运行多个命令行任务时，默认使用同一浏览器资料目录，应串行执行，或分别设置 `PLAYWRIGHT_USER_DATA_DIR`。

## 6. 配置与本地数据

配置通过启动命令的环境变量传入，项目不会自动读取 `.env` 文件。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `17321` | 工作台端口 |
| `CONTROL_PANEL_HOST` | `127.0.0.1` | 本地监听地址；建议保持默认，仅供本机访问 |
| `CONTROL_PANEL_MAX_JOBS` | `8` | 最大并发任务数，须为正整数 |
| `AUTO_OPEN` | 自动打开 | 设为 `false` 可关闭 macOS 自动打开网页 |
| `PLAYWRIGHT_SLOW_MO` | `0` | 浏览器操作额外延迟，单位毫秒 |
| `PLAYWRIGHT_AUTH_STATE_FILE` | `.playwright-auth-state.json` | 共享登录状态文件 |
| `PLAYWRIGHT_USER_DATA_DIR` | `.playwright-profile` | 单独运行脚本时的浏览器目录；工作台会为任务分配目录 |

例如，使用 17322 端口并将并发数调整为 2：

macOS / Linux：

```sh
PORT=17322 CONTROL_PANEL_MAX_JOBS=2 npm run ui
```

Windows PowerShell：

```powershell
$env:PORT = "17322"
$env:CONTROL_PANEL_MAX_JOBS = "2"
npm run ui
```

此时访问 <http://localhost:17322>。环境变量作用于相应进程或终端，重新打开终端可恢复未设置时的默认行为。

| 本地路径 | 内容 |
| --- | --- |
| `.playwright-auth-state.json*` | 登录状态及相关文件 |
| `.playwright-profile/` | 单独运行脚本的浏览器资料 |
| `.playwright-profiles/` | 工作台任务的浏览器资料 |
| `.control-panel/` | 客户输入、任务结果、生成配置及截图等运行文件 |
| `node_modules/` | 本机安装的依赖 |

这些路径已被 Git 忽略。共享项目时分享仓库地址即可，不要打包发送登录文件、客户资料或代理配置。使用命令行保存真实客户输入时，建议放在 `.control-panel/` 下，例如 `.control-panel/customer-local.txt`。

如果需要彻底切换账号，先停止工作台及所有任务浏览器，再将登录状态文件和上述两个浏览器资料目录移出项目目录保管，重新启动并登录。仅删除共享登录文件，仍可能从旧浏览器目录恢复原账号。

## 7. 常见问题

| 问题 | 处理方式 |
| --- | --- |
| `node` / `npm` 找不到 | 安装官方 Node.js LTS，重新打开终端并检查版本；不需要依赖作者的 Codex 路径 |
| Windows 提示不能运行 `npm.ps1` / `npx.ps1` | 使用命令提示符，或在 PowerShell 中改用 `npm.cmd` / `npx.cmd` |
| `npm ci` 失败 | 确认当前目录有 `package.json` 与 `package-lock.json`，Node.js 满足要求；确认能够访问官方包源 `registry.npmjs.org` |
| `Cannot find package 'playwright'` | 在项目根目录重新执行 `npm ci` |
| 找不到 Chrome / `Executable doesn't exist` | 安装 Chrome，或执行 `npx playwright install chromium` 安装备用浏览器 |
| 浏览器下载超时 | 检查网络或组织代理配置，再重试 Playwright 安装命令；只运行 `npm ci` 不会完成浏览器安装 |
| 浏览器无法启动，提示缺少显示环境或系统库 | 使用有桌面的系统；Linux 安装 Playwright 所需系统依赖 |
| 网页打不开 / `EADDRINUSE` | 检查终端是否仍在运行；17321 被占用时调整 `PORT`，访问对应新端口 |
| 登录一直等待 | 在脚本打开的浏览器里完成认证；确认账号权限及 Logto 服务网络访问正常 |
| 公司、规则或服务 ID 找不到 | 核对后台实际公司全名、应用名称和 ID；先检查已创建的服务，不要盲目重复开通 |
| 达到最大任务数 | 关闭已完成任务的浏览器，或点击“停止全部”，等待槽位释放 |
| 参数中有空格或特殊字符 | 给整项参数加引号；代理信息优先在网页填写，避免终端转义影响内容 |

## 8. 测试与更新

运行现有测试前，安装依赖、Playwright Chromium 和 Google Chrome。测试中的部分浏览器用例指定 Chrome，其余用例使用 Chromium。

```sh
npm test
```

测试使用本地模拟页面、临时文件及受控子进程；部分测试会监听本机随机端口，不会提交真实后台业务。测试通过不等于所有账号权限或远程后台页面都已验证，首次正式操作仍需核对后台结果。

通过 Git 下载的用户，可在停止工作台后更新：

```sh
git pull --ff-only
npm ci
npx playwright install chromium
npm run ui
```

如果提示本地修改冲突，请先保存自己的修改再更新。ZIP 用户可以下载新版本并按安装步骤重新安装。

## 项目结构

```text
scripts/                   自动化脚本、本地服务与任务管理
web/control-panel.html     工作台网页
examples/customer.txt      客户资料示例
examples/模板.txt           Magic 配置模板
test/                      自动化测试
run-control-panel.command  macOS 启动入口
mac-control-panel.command  macOS 简易启动入口
使用说明.txt               业务流程补充说明
```
