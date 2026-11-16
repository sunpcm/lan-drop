# LAN Drop / 隔空小站

一个只跑在自己电脑上的局域网互传小工具，用于在同一 Wi-Fi 下的手机和电脑之间快速传文字与图片。没有云服务，不依赖数据库，前端不构建，默认只在受信局域网内使用。

主文案：把这一刻，传到另一台设备。

## 快速开始

环境要求：Node.js 22 或更高版本。

```bash
cd lan-drop
npm install
npm start
```

启动后终端会打印访问码和本机局域网地址，例如：

```text
LAN Drop / 隔空小站 已启动
访问码：A1B2C3
  http://192.0.2.10:8787
  本机：http://127.0.0.1:8787
```

在手机或另一台电脑浏览器打开终端列出的局域网地址，输入访问码即可使用。
首次启动会自动生成 6 位访问码；登录任意设备后，可在页面右上角“设置密码”中把它改成自己的密码。之后启动时终端只显示“密码已自定义”，不会打印密码、哈希或 token。

macOS 也可以双击 `start.command`。脚本会先找 `node`，找不到时加载已有的 `~/.nvm/nvm.sh`；不会安装或修改全局环境。如果仍找不到 Node，会提示你在终端手动运行：

```bash
cd lan-drop
npm install
npm start
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `HOST` | `0.0.0.0` | 监听地址，通常是 `0.0.0.0` 或 `127.0.0.1` |
| `PORT` | `8787` | 监听端口 |
| `DATA_DIR` | `.data` | 数据目录，保存索引、访问码和图片 |
| `MAX_ITEM_BYTES` | `20971520` | 单个图片上限，20 MiB |
| `MAX_TEXT_CHARS` | `20000` | 单条文字上限，2 万字符 |
| `MAX_TOTAL_BYTES` | `536870912` | 图片和文字共用总存储上限，512 MiB |
| `MAX_ITEMS` | `1000` | 项目数硬上限 |
| `RETENTION_MS` | `86400000` | 内容保留时长，默认 24 小时 |
| `CLEANUP_MS` | `900000` | 过期清理间隔，默认 15 分钟 |
| `EXTRA_ALLOWED_HOSTS` | 空 | 额外允许的 Host，逗号分隔 |

示例：

```bash
PORT=9999 DATA_DIR=/tmp/lan-drop-test npm start
```

## 使用说明

- 文字：输入后点“发送文字”，或直接粘贴到页面。收到后可直接复制。
- 图片：点击“选择图片”、多选、拖拽到发送区，或使用 Ctrl/⌘ + V 粘贴。图片上传后会在收件箱显示预览，可下载原图。
- 设备名：由当前浏览器在本地记住，是仅用于本地显示的标签；服务端不据此识别消息来源设备。
- 同步：页面每 2.5 秒轮询一次，使用 revision 避免重复拉取。
- 清空：会先弹确认；删除单条同样有确认。
- 手机扫码：发送区和收件箱下方的“手机扫码连接”默认收起，展开后会默认使用当前访问地址或首个本机局域网 IP；可修改 IP，输入后自动生成带实际端口的 `#token=...` 二维码和复制链接，按 Enter 可立即重试。token 只放 fragment 和本地浏览器存储，不放在 URL query 中。页面读取后会立即清除 fragment。
- 设置密码：登录后点右上角“设置密码”，输入当前访问码或当前密码、新密码和确认值。新密码需为 8–64 个字符，区分大小写，前后空格会保留，但不能全是空白。

修改成功后，当前页面会切换到新 token 并自动刷新二维码；其他已连接页面会在下一次轮询收到 401 后清空预览、二维码和本地 token 并回到登录页。旧二维码、旧密码和旧 token 不能再次换取连接。已被其他设备下载或复制走的内容无法远程擦除，本功能保护的是撤销后的 API 访问和页面本地预览。

## 隐私与 HTTP 边界

默认服务是明文 HTTP，仅适合可信局域网。请在防火墙允许入站访问 `8787` 端口，并确认路由器和无线 AP 没有开启客户端隔离。不要把它直接暴露到公网。

认证数据保存在 `DATA_DIR/auth.json`，文件权限会设置为 `0600`，`DATA_DIR` 目录设置为 `0700`。旧版本的明文访问码格式继续兼容；设置自定义密码后，文件只保存带随机 salt 的 scrypt 哈希、新 token 和 deviceId，不保存或返回明文密码。浏览器拿到 token 后会放在 `localStorage`，这是同一浏览器设备复用连接所需的本地保存。

图片只接受服务端识别出的安全光栅格式，例如 PNG、JPEG、GIF、WebP、AVIF、HEIC/HEIF；拒绝 SVG/HTML 和伪造 MIME。页面使用 `textContent` 显示文字，避免把文字当作 HTML 执行。

如果 HTTP 剪贴板复制在手机上不可用，请手动选择文字复制；旧浏览器没有图片剪贴板 API 时，图片复制会提示失败，此时可长按预览保存或使用下载。

## 排错

- 手机打不开：确认手机和电脑在同一 Wi-Fi，防火墙未阻止端口，客户端隔离未开启。
- 端口被占用：设置 `PORT` 换端口，例如 `PORT=8899 npm start`。
- Node 找不到：安装 Node.js 22+，或确认 `~/.nvm/nvm.sh` 存在。
- 密码或访问码忘了：按“忘记密码时重置”停服并保留原认证文件，再重启生成全新的访问码；收件箱索引和图片仍在 `DATA_DIR/index.json` 与 `DATA_DIR/files/`。
- 图片传不了：确认不是 SVG/HTML，且文件小于 20 MiB。
- 手机真实访问：本机开发环境已做接口和页面逻辑测试，但真实手机浏览器访问尚未在本次实施中验证。

## 密码变更、备份与灾难恢复

### 在线修改

在登录后的页面点击“设置密码”即可在线修改，无需停止服务。界面会先验证当前访问码或密码，成功后旧密码、旧 token 和旧二维码立即失效。

### 本机认证备份

如需另外保留本机认证备份，可在停服后复制当前 `auth.json`。备份包含当前 token，应按敏感文件保管：

```bash
cd lan-drop
DATA_DIR="${DATA_DIR:-.data}"
backup="$DATA_DIR/auth.json.backup-$(date '+%Y%m%d-%H%M%S')-$$"
test ! -e "$backup"
cp -p -n "$DATA_DIR/auth.json" "$backup"
chmod 600 "$backup"
```

### 忘记密码时重置

忘记密码时，先停止服务，验证原 `auth.json` 是有效 JSON，再按时间戳改名保存。不要删除它或覆盖已有备份；保留 `index.json` 与 `files/`，随后重启，程序会生成全新的访问码和 token：

```bash
cd lan-drop
DATA_DIR="${DATA_DIR:-.data}"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$DATA_DIR/auth.json"
backup="$DATA_DIR/auth.json.before-reset-$(date '+%Y%m%d-%H%M%S')-$$"
test ! -e "$backup"
mv -n "$DATA_DIR/auth.json" "$backup"
chmod 600 "$backup"
```

### 仅灾难恢复

重启后重新打开页面并保存新的访问码。只有灾难恢复才考虑停服后恢复旧认证备份；恢复会带回备份中的旧 token，可能让当时签发过、后来已撤销的二维码重新有效。不要把旧备份复制回来作为常规忘记密码流程，也不要覆盖唯一备份。不要公开、提交或通过聊天发送 `auth.json` 和备份文件。

## 测试

```bash
npm test
npm run check
```

测试只使用临时 `DATA_DIR` 和 `127.0.0.1` 随机端口，不会触碰真实存储。覆盖文字、图片鉴权、复制/下载接口字节一致、重启持久化、删除、并发、无效图片、限额、过期清理、Host/Origin 与限流，以及密码轮换后的全接口旧凭据失效、并发改密、慢上传门闩和认证文件落盘失败恢复。

## 项目结构

- `server/index.js`：程序入口。
- `server/app.js`：`createApp` 与 API/静态服务逻辑。
- `server/auth.js`：旧访问码兼容、scrypt 密码校验和自定义凭据轮换。
- `server/store.js`：持久化、原子索引、图片存储与清理。
- `server/security.js`：访问码、token、Host/Origin 和安全小工具。
- `public/`：无构建的原生 HTML/CSS/JS。
- `.data/`：运行时数据目录，已被 `.gitignore` 忽略。
