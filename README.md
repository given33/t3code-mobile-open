# Mobile Link for T3 Code

这是基于 T3 Code 开源生态的**独立、非官方**宿主插件和移动端项目，与官方无隶属或背书关系，不包含官方商标图形、Logo 或聊天 UI。仓库提供宿主插件、WebView 桥接层和 iOS 客户端源码，不提供已签名的客户端。手机看到的是已安装宿主提供的原生 Web 应用；插件不另外实现聊天界面。

## 安装与使用

需要支持 `t3code.plugin`、`ctx.issueLocalSession` 的 T3 Code 宿主，以及开发机上的 Node 22+、npm 和 Git。

```sh
npm --prefix plugin ci --ignore-scripts
node scripts/check-privacy.mjs
npm --prefix plugin test
npm --prefix plugin run pack:plugin
t3 plugin add build/t3-mobile-link-0.4.1.tgz
```

若宿主 CLI 报 `Missing required flag: --no-enable`，请运行 `t3 plugin add --no-enable=false --link=false build/t3-mobile-link-0.4.1.tgz`：显式选择复制并启用，效果相同。

归档包含运行依赖及许可；安装端不运行包管理器、安装脚本或 OpenSSL 命令。到 **Settings → Plugins → Mobile Link** 开启监听，核对地址、扫码并通过独立可信渠道对照安全码。配对码有效五分钟、消费后不可复用，面板可换码或撤销设备。默认不监听；启用后默认所有 IPv4 接口、端口 3081、只读、无终端。限制监听网卡或使用受信网络与防火墙。`extraHosts` 和 `tunnels` 是额外公布的 TLS 地址，不创建隧道。TLS 必须端到端抵达同一已固定公钥的监听器。

宿主初始配置参考 `deploy/examples/plugin-config.example.json`；面板更新的三个开关在插件状态目录中持久化并优先于初始配置。停用监听或修改权限会断开活动代理连接；会话失效后原生客户端应使用设备令牌重建 WebView 会话。写权限允许驱动宿主代理处理任务，能力很强，并非 OS 沙箱；终端开关控制原生终端 RPC，不是对可写代理执行命令的系统级隔离。手机端禁止插件管理、授权转授和未知 RPC；未来宿主扩展可能需要更新允许列表。

## 客户端协议

- 解析 `t3mobile://pair` 中的 `id`、`name`、`role`、`pin`、`code` 和逗号分隔的 `hosts`。**在发送任何凭据前**验证叶证书有效期和 DER SubjectPublicKeyInfo 的 SHA-256（base64url，无填充），并检查 `GET /mobile/v1/hello` 的主机 ID／指纹。严禁仅绕过系统 TLS 错误或将私有 CA 全局设为可信。
- `POST /mobile/v1/pair` 发送 JSON `{code,name}` → `{deviceId,token,host,actions,terminal,family}`。令牌只应保存在系统 Keychain。以 Bearer 调用 `POST /mobile/v1/web-session`，将响应的 Secure/HttpOnly/Strict Cookie 放入专用 WKWebView cookie store，再加载 `/`。原生 HTTP、WebView 与 WSS **均需验证同一 pin**；不要将令牌放入 URL 或 JS。设备不要共享 WebView 存储。Cookie 一小时有效，重启不保留。
- `GET /mobile/v1/sync` 返回认证后的宿主健康状态；`POST /mobile/v1/unpair` 撤销当前设备。两者接受 Bearer 或 Cookie。桌面管理面板不能经手机代理访问。
- 页面提供 `window.__T3_MOBILE_BRIDGE__` 的 `toggleSidebar`、`openRoute`、`insertDraft`、`setKeyboard`、`reconnect`、`voiceEvent`。发往 WKScriptMessageHandler `t3Mobile` 的事件以 `type` 区分：`ready`、`theme`、`route`、`ws`、`auth-expired`，以及携带布尔字段 `drawerOpen` 的 `ui`。原生壳必须只接受已固定来源主框架的消息，并阻止不可信导航。

## Family 节点与撤销

仅在宿主的插件 `stateDir` 中放置 `family-route.json`（用示例模板替换双方实际 ID、角色、地址和经验证的 pin）。`pair`、`web-session`、`sync` 均返回经筛选的 Family 路由；手机应各自固定两端的 pin，分别探活，只有目标节点 `sync.upstreamOk` 才切换。面板对配置的对端执行无凭据的 pinned hello 探测。路由文件**不授予权限**。

同一手机跨端访问需由管理员通过安全的带外渠道在对端预置 `family-grants.json`：`{ "familyId": "example-family", "devices": [{ "id": "example-device", "name": "Phone", "tokenHash": "<sha256-base64url-of-device-token>", "expiresAt": 0 }] }`。`expiresAt` 为将来的 Unix 毫秒时间；哈希和 ID 可由配对节点状态安全提供，无需导出明文令牌。路由与 grants 在请求时读取；本机撤销持久化且优先于本机 grants；**不会向另一台主机传播撤销**，管理员应在两端分别撤销。未配置 grants 时仅用于发现，对端仍需单独配对。

## iOS / iPadOS 17 客户端

`ios/T3Mobile` 是独立的 SwiftUI 壳；网页聊天、附件选择和输入框来自宿主的原生 Web UI。打开设备菜单配对，扫描面板二维码或粘贴链接，逐组核对安全码再确认。设备令牌及 Family 配对数据仅存于本机 Keychain。原生探测、WebView 和下载使用同一套叶证书有效期、P-256 SPKI 和地址检查，不跟随原生请求重定向。更换宿主密钥须重新配对。不要为任意域名或子域放宽 ATS。

- 点击设备胶囊可查看本机与云端的认证探测结果。每轮并行验证各地址的 `hello` 和 `sync`；在上游健康的地址里优先 LAN，再比延迟。绿灯表示上游在线，黄灯表示探测中或上游异常，红灯表示不可达或未获授权。仅发现 Family 对端不足以打开其网页，还需要有效 grant 或单独配对。
- 自动接力默认关闭。开启后，当前节点所有地址连续两轮确认断线或上游不可用（证书、协议或授权失败不算断线）、对端本轮 `upstreamOk` 明确为真且确认同一 Family 才会切换；切换有 30 秒冷却，不因本机重新上线而强制切回。它切换的是连接，不复制任务、聊天记录或未发送草稿。每台主机有独立的 WebKit 存储、最后访问的路径和受文件保护的恢复快照。
- 顶部按钮控制网页侧栏、离线语音听写和连接设置。听写只填入草稿，不会自动发送。支持系统文件选择器和 Quick Look 可识别的同源下载；外部页面及子框导航被拦截。撤销某一端不会撤销另一端；仅从手机移除不能替代宿主撤销。

**从源码构建**（macOS，安装完整 Xcode、iOS SDK 和 Homebrew）：

```sh
swift test --package-path ios/Core
brew install xcodegen
xcodegen generate --spec ios/project.yml
xcodebuild build -project ios/T3Mobile.xcodeproj -scheme T3Mobile -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
bash scripts/build-ipa.sh
```

输出 `build/T3Mobile-unsigned.ipa` 与 SHA-256 校验文件。无签名 IPA 用于验证归档，并非可直接安装的发行版；需要上机时，在本地 Xcode 单独配置自己的签名，不要写回仓库。纯逻辑包也支持 Linux Swift 5.9+（安装 `pkg-config`、`libssl-dev` 后运行同一条 `swift test`）。协议 fixture 来自临时启动的插件，设备令牌已替换为不可用的占位值；Node 及 Swift 测试共同检查证书向量、响应和桥接事件。

## 隐私和验证

证书与私钥、设备哈希、访问时间、面板设置及 Family 文件仅在运行状态目录，不记录令牌、配对码或聊天内容。限制该目录的 OS 权限（Windows 使用用户专属 ACL）。不要公开状态、二维码、配置实值、截图或日志。隐私守卫检查 Git 跟踪文件、未忽略文件和暂存内容，不是人工发布审计的替代品。

CI 在 Windows/Linux 检查隐私、单元测试和打包。真实宿主验证：先打包，再执行 `node scripts/e2e.mjs <host-bin.mjs>`；脚本创建并清理独立临时主目录，使用随机端口和真实会话，不需要现有账号或真实凭据。

本项目使用 MIT 许可证。附带的第三方包保留其原许可。

## 0.2.0：跨端源码同步与接力

同步默认关闭，Family 路由不会自动授权读取源码。授权清单、SSH 收件、冲突处置、租约的作用范围和回滚见 `deploy/cloud/README.md`。认证的 `GET /mobile/v1/relay/status` 报告状态；`GET /mobile/v1/sync` 仅在启用时增加 `relay`。可写设备可登记 `POST /mobile/v1/relay/checkpoint`，或调用幂等的 `POST /mobile/v1/relay/handoff`，请求含 `threadId`、`targetRole` 及可选 `handoffId/projectKey/title/summary`。成功返回已确认的目标收件路由；冲突或断线不当作成功。不会在目标端自动重放未回执命令。

## 0.3.0：原生线程接力

文件传输授权不等于在目标端执行 agent 的授权。需要续跑时，两端管理员先为同一个 `projectKey` 配置 `source-grants.json`，并在目标工作区条目显式设置 `"nativeHandoff": true`。两端都需启用 Mobile Link、`actions` 和 `taskSync`。目标需事先注册对应的原生项目并配置默认模型；`taskSync.autoContinue: false` 可强制只投递收件箱。本地工作区路径不会传给对端。

接力先关闭源端插件写入，再使用原生中断及投影核对停止结果。只有已确认的停止或空闲观察、唯一领取和无冲突的源码版本都具备，目标才使用持久化命令 ID 派发原生 turn。源端失联时目标可以先领取并展示收件箱，**不会把心跳超时冒充 provider 已停止**；源端恢复并确认后才可升级到线程路由。此约束不禁止用户通过桌面主动发起新的独立操作。已发出的外部副作用不能靠中断撤销；`TOOL_OUTCOME_UNKNOWN` 要求先核验，再决定是否继续。

个人构建可运行 `bash scripts/build-ipa.sh --icon /path/to/icon.png`，或设置 `T3MOBILE_ICON_PATH`。使用有权使用的 1024×1024 PNG。脚本在临时构建副本替换图标。
