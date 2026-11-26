# 云端网关 + Codex 工作节点

网关只公开现有的 TCP 443。T3 管理端监听 `127.0.0.1:18371`；Mobile Link 在 `127.0.0.1:18372` 终止 TLS。仅新 SNI 先到 `127.0.0.1:18374` 去掉前置 Nginx 发出的 PROXY 头。该跳不终止 TLS、不改 WSS，也不向插件传递原始客户端地址（按地址限流会共享额度）。示例名仅为占位符，部署前替换；真实路由、授权、公钥指纹和配对信息都不应进入仓库。

## 准备运行时（在构建机做）

1. 记录两个节点的磁盘、内存、Swap 和既有服务状态。只清包缓存、归档日志和不在使用的构建缓存；不要清业务目录、镜像或卷。记录既有 443 路由的 TLS/HTTP 响应作为回归基线。
2. 在 fork 中运行 `pnpm --filter t3 exec node scripts/cli.ts build`。不要单独复制 `bin.mjs`：需要同版 chunks、workers、`dist/client/`（包括 `index.html` 和 assets）。根据该版本的 server manifest、锁文件与 `scripts/lib/cli-external-packages.ts` 在**构建机**准备 Linux x64 GNU 运行时。保留 JS 依赖和仓库补丁，选择同平台的 `node-pty`、keyring、FFF、FFI 等预编译依赖。SQLite 来自 `node:sqlite`，不是系统 sqlite 命令。只做 Codex 时可排除可选的 Cursor 原生 agent、语音模型和浏览器引擎，不应将这些功能标成已部署。
3. 使用该版本支持的独立 Linux Node，核验官方下载的校验和；在 Linux 上检查 SQLite 查询、PTY 子进程、真实宿主端到端测试和静态页面。以发行版为准复核目标 glibc/libstdc++，打包时排除 sourcemap 和其他平台 prebuild，不带 `.env`、开发者 home 或认证文件。校验传输后的摘要，将 `bin/node`、`dist/`、`node_modules/` 安装到 `/opt/t3-cloud`，程序目录和所有祖先由 root 持有且不可由服务用户改写。不要在网关上安装整个工作区依赖。
4. 从该 fork 的 `CodexInstallation.ts` 读取固定的 Linux x64 发行包和 SHA-256，校验后完整解压（含 `codex-package.json`、`codex-path`、`codex-resources`）。工作节点路径 `/opt/t3-codex/bin/codex`。网关采用 `/opt/t3-cloud/codex-runtime/`，从 `/opt/t3-cloud/bin/codex-local` 链接到 `../codex-runtime/bin/codex`。不覆盖系统 Node 或 Codex。

## SSH 桥

- 网关用无 sudo 的 `t3-cloud`，home `/var/lib/t3-cloud`，工作目录 `/var/lib/t3-cloud/workspace`。工作节点用另一个无 sudo 的 `t3-codex`、可用的 POSIX 登录 shell、home `/var/lib/t3-codex`、工作目录 `/var/lib/t3-codex/workspace`。两个 home 和 `.ssh` 都是 `0700`。在工作节点上保留 `/var/lib/t3-cloud/workspace` 指向其实际工作目录的只读管理链接，以便 JSON-RPC 中的绝对项目路径也有效。仅在路径空闲时创建，不接管其他应用目录。
- 将 `codex-ssh-wrapper.sh` 分别以 root 所有、`0755` 安装为网关 `/opt/t3-cloud/bin/codex` 和工作节点 `/opt/t3-codex/bin/ssh-dispatch`。在网关以服务用户运行 `ssh-keygen -t ed25519 -f /var/lib/t3-cloud/.ssh/id_ed25519`，专用无人值守密钥仅供本服务使用。在工作节点将**公钥**作为 `restrict,command="/opt/t3-codex/bin/ssh-dispatch" <public-key>` 安装到服务用户的 `authorized_keys`，权限 `0600`。该账号可运行编码任务，不是操作系统级沙箱；不要授予 Docker、sudo 或其他项目权限。
- 通过**已经验证的管理 SSH 连接或控制台**读取工作节点主机公钥。网关 `/etc/t3-cloud/known_hosts` 只写 `codex-worker <key-type> <public-key>`，由 root 管理。`codex-worker` 仅是这份配置的逻辑标签。不要将 `ssh-keyscan` 的结果直接视为可信。
- 建立 root 持有的 `/etc/t3-cloud/ssh_config`：

```sshconfig
Host codex-worker
    HostName worker.example.invalid
    User t3-codex
    Port 22
    IdentityFile /var/lib/t3-cloud/.ssh/id_ed25519
    IdentitiesOnly yes
    BatchMode yes
    PasswordAuthentication no
    StrictHostKeyChecking yes
    HostKeyAlias codex-worker
    HostKeyAlgorithms ssh-ed25519
    UserKnownHostsFile /etc/t3-cloud/known_hosts
    GlobalKnownHostsFile /dev/null
    UpdateHostKeys no
    ForwardAgent no
    ClearAllForwardings yes
    Compression no
    TCPKeepAlive yes
    ServerAliveInterval 15
    ServerAliveCountMax 3
    ConnectTimeout 6
    IPQoS throughput
```

在该 Host 块补上 `Ciphers`：从 `ssh -Q cipher` 读取 `aes128-gcm@` 和 `chacha20-poly1305@` 开头的完整算法名，按该顺序逗号连接。用 `ssh -G -F /etc/t3-cloud/ssh_config codex-worker` 在本机检查，不要发布输出。安装同名 systemd 示例（去掉 `.example`），执行 `systemctl daemon-reload`、`systemctl enable --now t3-hk-ssh-mux.service`。`/run/t3-cloud` 的 `0700` 由 mux 单元独占管理；服务重启不会删除另一服务的 socket。

- 封包只传 argv、相对工作目录和 `LANG`、`LC_ALL`、`TERM`、`NO_COLOR`、`RUST_LOG`，不传凭据、SSH agent、`PATH`、`HOME` 或 `CODEX_HOME`。默认使用工作节点自己的 Codex 登录。stdin/stdout 留给 app-server；诊断走 stderr；已启动的命令断线不重放。子项目须在工作节点已有同名目录；**路径映射不是文件同步**。切本地时写 `/etc/t3-cloud/runtime.env`：`T3_CODEX_EXEC_MODE=local` 并重启 `t3-cloud`。本地模式有独立的认证、文件和会话。

## 插件与 443

在网关设置 `HOME`、`T3CODE_HOME` 均为 `/var/lib/t3-cloud`，在工作目录以 `t3-cloud` 执行 `/opt/t3-cloud/bin/node /opt/t3-cloud/dist/bin.mjs plugin add /path/to/t3-mobile-link-0.2.0.tgz`。不要传默认布尔选项。安装 `t3-cloud.service` 示例，启动后通过回环的已认证插件管理端设置以下配置；不得输出管理 bearer、配对面板或完整 hello：

```json
{"enabled":true,"host":"127.0.0.1","port":18372,"role":"cloud","name":"Cloud T3","extraHosts":["mobile.example.invalid:443"],"actions":false,"terminal":false}
```

确认 `/api/plugins` 为 `active`、`/.well-known/t3/environment` 返回 200、管理端与插件均只监听回环。备份现有 SNI map **到 include 目录外**。只加入新主机名到 `127.0.0.1:18374` 的映射，并把 `nginx-t3-cloud.conf.example` 的 server 块安装到原 stream include 中；外层须已启用 `ssl_preread` 和 `proxy_protocol on`。先 `nginx -t`，成功后才 `nginx -s reload`。复测原有路由和服务；失败则恢复原 map、撤掉本次新块，再测试并 reload，不重启其他服务。

## 验证与退出

- 用可信管理通道取得**叶证书公钥 SPKI** 的 SHA-256；公网客户端在发 HTTP 前完成 pin、有效期和目标主机校验。GET `/mobile/v1/hello` 应为 `200`、`backend=t3code`、`host.role=cloud`；错误 pin 必须在发送 HTTP 前失败。不要用 `curl -k` 成功作为验收。
- 检查单元、`ssh -O check`、`codex-local --version`、包装器 `--version`、`app-server` 的 JSON-RPC `initialize`、T3 的 provider 快照。计时冷、热路径时使用相同用户、相同 argv 和远端目录；冷路径仅用 `-S none`，不要拆掉生产 mux。记录独立样本、中位数和计时边界，不把握手耗时说成模型响应时间。
- 若未登录，由用户在工作节点以 `t3-codex` 运行 `/opt/t3-codex/bin/codex login`，不复制网关或桌面凭据。退役时先回滚 SNI、停止并禁用两个新增单元、撤销本专用公钥。保留状态、项目、身份与日志供管理员决定，不自动删除。

## 两类不能用“服务 active”代替的检查

1. **DNS 与 pin 分开验证。** 若系统 DNS 返回代理合成地址，应分别记录默认解析与独立解析的结果。可在测试进程内用可信 DNS 解析，保留原 URL 主机名、TLS SNI 和相同 SPKI pin，不要永久修改 hosts 或关闭校验。记录计时是否包含 DNS。外部直连正常不代表设备的默认 DNS 路径已恢复。
2. **远端沙箱独立于账户登录。** 用专用工作用户执行 `codex login status`。即使 `app-server` 的 `initialize` 成功，还要测试沙箱内的无副作用命令（例如通过 `command/exec` 执行 `/usr/bin/pwd`）。若出现 `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`，不要用 root、关闭 AppArmor、改全局 sysctl 或无沙箱模式来“通过”。由主机管理员批准适用于该专用工作负载的沙箱配置后复测。登录不会修复内核权限问题。

## Ubuntu 24.04：只授权实际创建 user namespace 的助手

先以部署账户（不是 root）通过常驻 mux 运行 `verify-codex-mux.py`。`initialize` 或 CLI 版本成功不能证明沙箱可用。若只读 `command/exec /usr/bin/pwd` 因 loopback 被拒，管理员先用 `namei -l /opt/t3-codex/codex-resources/bwrap` 核实整个路径由 root 拥有且不可由服务用户改写，并确认该文件来自已经校验的发行包。`apparmor-t3-codex.example` 只匹配这个绝对路径，不匹配 CLI、shell 或目录通配符；`flags=(unconfined)` 是给原本未受 profile 限制的特定程序授予 `userns` 的方式，不得用它替换已有约束更强的 profile。只在确认同名文件和 attachment 均未被其他管理员占用后执行：

```sh
sudo apparmor_parser -QT apparmor-t3-codex.example
sudo install -o root -g root -m 0644 apparmor-t3-codex.example /etc/apparmor.d/t3-codex-userns
sudo apparmor_parser -a /etc/apparmor.d/t3-codex-userns
sysctl -n kernel.apparmor_restrict_unprivileged_userns # 必须仍为 1
cat /sys/module/apparmor/parameters/enabled              # Y
# 网关：以服务用户过现有 mux，真实执行一个无副作用的只读命令
sudo -nu t3-cloud ssh -F /etc/t3-cloud/ssh_config -S /run/t3-cloud/hk.mux -O check codex-worker
sudo -nu t3-cloud timeout 25 python3 -I - < verify-codex-mux.py
```

预期 `exitCode=0 expectedWorkspace=True loopbackDenied=False`。当 PATH 没有系统 bubblewrap 时，CLI 可提示将使用 bundled bubblewrap；验收以实际 RPC 退出码为准。回滚时只卸载这个新增 profile（`sudo apparmor_parser -R /etc/apparmor.d/t3-codex-userns`），再由管理员移走该文件。不重启 AppArmor、不改 sysctl、不用 root 运行 Codex。升级二进制或安装路径变化时重新核对和复测。

## 0.2.0：两端显式授权后才启动接力

- 两端分别设置插件 `taskSync: {"enabled":true,"role":"local"}` / `"cloud"`。没有这个显式角色或未开启，不建立传输、不枚举目录、没有后台上传。手机 API 仍需 Bearer/Cookie；登记和交接还需开启 `actions`。不要在生产机上为验证安装而顺便打开权限。
- 在各端的插件私有状态目录中人工创建 `source-grants.json`，使用真实的本地规范绝对路径，例如 `{"sample":{"root":"/srv/example-workspace","allow":["src/","docs/*.md","README.md"],"threadIds":["sample-thread"]}}`。本地根路径不传输。`threadIds` 可将不携带 projectKey 的移动路由绑定到已授权工作区，不猜测工作区。`src/` 表示子树；支持 `*`、`?`、`**`。空名单不意味着全部。不能用磁盘根、与状态目录重叠的目录、符号链接/目录联接或多硬链接文件。只授权受信的工作目录，不将同步器当作对抗恶意本地进程同时替换目录的 OS 沙箱。
- 忽略嵌套 `.gitignore` 中的普通文件名、通配、锚定、目录与否定规则；未支持的转义等规则拒绝同步。默认不传隐藏文件、产物及凭据；单文件 2 MiB、4096 项，单包原始内容限 32 MiB，超过需缩小授权范围。修改/删除按共享基线比对；冲突时本地文件不动。到 `task-sync/source/conflicts/<projectKey>/<rev>/manifest.json` 查路径与只读远端内容（删除为 null）；人工审阅并使本地文件匹配所选版本后再重试。不要用删除状态目录来解决冲突。
- **传输**：复用严格验证 known_hosts 的 SSH；为同步单独限定密钥及 forced command，不能复用执行 Codex 的远程任意命令能力。安装 `t3-sync-transfer.py` 为管理员只读，在授权公钥上设置 `restrict,command="/usr/bin/python3 -I /opt/t3-sync/t3-sync-transfer.py /srv/example-plugin-state"`。示例 SSH 配置：`Host sync-peer`、`HostName peer.example.invalid`、`User example`、`IdentitiesOnly yes`、`BatchMode yes`、`StrictHostKeyChecking yes`、`UserKnownHostsFile /etc/t3-sync/known_hosts`、`IdentityFile /etc/t3-sync/identity`；带外核对主机密钥，不依赖未经验证的首次连接。运行目录仅限服务用户读写。
- 双方可直连时，各自设置 `taskSync.sshConfig` 为本端受保护的配置绝对路径；不可反连 Windows 时，两端都不设置它，启用本地 spool，在 Windows 以插件用户手动运行 `deploy/windows/t3-cloud-inbox.ps1 -StateDir <本机插件状态目录> -SshConfig <本机已验证配置>`，同时拉取和推送。`-Once` 仅跑一轮。没有定时任务、自启动安装或自动导出凭据。两边插件进程均需在线才有心跳确认；SSH 通不代表宿主活着。
- **租约与交接**：登记活动线程后，确认 Offer → 源端持久化 armed → 确认 peerArmed，默认 12 秒不续租源端拒绝通过插件代理继续写，备用端至少等 20 秒；强制 `takeoverDelayMs > sourceFenceMs + 2000`。收到停机 surrender 可立即领取，但授权源码必须已收到、完整匹配且无冲突。重复投递只复用同一 `claims/<id>.json`，claim 结果反向确认；重启不恢复过期发送权。收件路由只展示校验后的上下文，不执行交接文本。`TOOL_OUTCOME_UNKNOWN` 必须核对实际结果，绝不自动重放命令。
- **执行边界**：手机切换、工作区补丁、租约和收件均由插件管理；目标 `targetRoute` 是该端已领取的上下文收件页，而非伪造的原生线程。插件的写入门不控制桌面直接提交的请求，也不能暂停已经在宿主/provider 内运行的 turn。要无人工参与地继续原生 turn，需宿主执行器提供原子停步和幂等恢复契约。在此之前不要部署双活原生执行器。

### 老版管理器没有 `plugin update` 时

`plugin add` 返回 `Plugin is already installed` 时，不要 `remove` 再安装（会危及状态/配置）。先在服务用户私有的 `BASE/mobile-link-release.<随机>/` 中保留旧包、已校验 SHA-256 的 `new.tgz`；用 `T3CODE_HOME=RELEASE/stage` 调同一宿主 CLI 安装新包。仅对 **非 link 的相邻版本 0.1.0 → 0.2.0、0.2.0 → 0.3.0 或 0.3.0 → 0.4.0**，`offline-upgrade.py` 可在停止目标服务后由该服务用户运行 `python3 -I offline-upgrade.py apply BASE RELEASE`：在同一文件系统原子交换包目录，并备份、替换目标 registry 条目的版本与包来源，保留 `enabled`、`config` 和其他所有条目。不读取或移动插件 state，不改 Nginx。随后重启目标服务并独立验证身份、pin、版本、角色。若验证失败，停止目标服务后立即以相同参数执行 `rollback`，再启动；若之后已有其他配置更改，不应直接恢复旧 registry。不要覆盖原始备份。网关通过仍保持原 SNI 并在发 HTTP 前校验旧 pin 的探针验收；分别报告默认 DNS 和指定已验证公网地址的结果。

### 0.3.0：按工作区启用原生接力

升级宿主与插件不需要重建身份、配对、Family、SSH 或代理配置。单独备份宿主 `dist` 并准备可回滚的同平台运行时。默认不改变旧工作区的授权；要允许目标 agent 在该工作区续跑，管理员必须在该端对应的 `source-grants.json` 工作区条目设置 `nativeHandoff: true`，并保持 `actions` 开启。新项目线程使用本端项目默认模型和审批模式。可在 `taskSync` 或单次请求中设置 `autoContinue: false`。仅有租约到期或传输回执时继续显示收件箱，不能把失联当成 provider 已停止的证明。
