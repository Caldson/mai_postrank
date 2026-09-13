# mai_postrank · 舞萌DX 点歌页

一个纯静态的舞萌DX（maimai DX）点歌页面：选难度 → 搜曲目（支持中文别名）→ 一键把点歌写进本仓库的 `posts.txt`。

可以直接丢到 GitHub Pages 上，不需要服务器、不需要数据库。

## 页面长什么样

- **难度**：BASIC / ADVANCED / EXPERT / MASTER / REMASTER / 宴，配色沿用舞萌的难度色，打开时默认选中 **EXPERT**（选择会记在本机）
- **点歌限制**（`config.js` 的 `rules` 可以逐条调成 `warn` 只提示 / `off` 不检查）：
  - 选到 **Re:Master** → 「我是萌新！！无法选择！！」
  - 选到 **宴** → 跟 Re:Master 同理，同样拦下（宴会場曲子不能通过这个页面点）
  - 选到**已删除的曲子** → 「无法选择删除曲！」（手动打曲名也会被拦）
  - 选到 **BASIC 且定数低于 7** → 「太简单了！」（阈值是 `easyBasicBelow`，按定数小数值比较，例如 6+ = 6.8 会触发、7 = 7.0 不触发）
  - 所选难度的**定数超过 `levelmax.txt` 里的上限** → 「太难了！（等级上限 13.0）」
  - 文案在 `app.js` 顶部的 `BLOCK_MESSAGES` 里，想改口吻直接改
- **搜索**：曲名、中文别名、曲师都能搜；平假名 ⇄ 片假名互通（搜「ねこ」能找到「ネコ日和。」）
- **曲目信息**：版本、分类、BPM、当前难度的 STD / DX 定数与谱面设计者
- **重复检测**：队列里已经点过的同一难度同一首歌会给出提示，提交前再确认一次
- **点歌榜**：页面最底部按**提交先后**排出名次（`1.`、`2.`、…），每行是「名次 + 难度徽标 + 曲名」，
  默认最多 50 条（`config.js` 的 `boardLimit` 可调）。排名规则就是 `posts.txt` 的文本顺序：
  第一行第 1 名，越晚提交的位置越靠后；同一首歌可以重复上榜，各占一个名次
- **点歌开关**：`publishstate.txt` 不是 `true` 时按钮禁用并显示「已暂停点歌」
- 移动端可用：手机上难度按钮两列排布，输入框 16px 不会触发 iOS 缩放

### 点歌开关是只读的（重要）

`publishstate.txt` 由主播一人控制，**页面只会读它，永远不会写它**——代码里写文件前有 `assertWritablePath()`
兜底，任何试图写 `publishstate.txt` 的调用都会直接抛错；整个页面唯一会写的文件就是 `posts.txt`。

判定规则（故意做成"关了就是关了"）：

| `publishstate.txt` 内容 | 结果 |
| --- | --- |
| `true`（大小写、首尾空白都容忍） | 开放点歌 |
| `false` / 其它任何值 | 「已暂停点歌」，提交和「复制点歌文本」都禁用 |
| 文件为空 / 文件不存在 | 「未开启点歌」，同样全部禁用 |
| 读不到（网络失败、仓库私有又没 Token） | 「开关读取失败」，全部禁用并提示稍后刷新 |

也就是说，只要不是明确的 `true` 就不放行；页面刚打开、还没读到开关的那一瞬间也是禁用状态（fail-closed）。
要改开关，就是你自己在 GitHub 网页上把 `publishstate.txt` 改成 `true` 或 `false`，页面最多 60 秒内自动跟上
（也可以刷新页面立即生效）。

### 等级上限 `levelmax.txt`（同样只读）

里面写一个小数，例如 `13.0`：**所选难度的定数大于这个值就不让点歌**。同样是页面只读、只有你能改。

| `levelmax.txt` 内容 | 结果 |
| --- | --- |
| `13.0` | 定数 > 13.0 的曲子不能点（消息里会带上当前上限） |
| `13`、` 13.5 `、`13.0\n` | 都按小数解析 |
| 空文件 / 文件不存在 | 不设上限（设置面板会显示「未设置」） |
| 内容不是数字（例如 `13,0`、`十三`） | 拦住并提示「内容不是数字」，避免规则静默失效 |
| 读不到（网络失败） | 拦住并提示稍后刷新（fail-closed，跟开关一致） |

判断方式跟「太简单」对称：只有当该难度下**所有**谱面（STD 和 DX）定数都超过上限时才拦；
比如 STD 12.5 / DX 14.5、上限 13.0，还有一张能玩，就不拦。

### 删除曲是怎么认出来的lxns 的 `song/list` 默认只返回**当前版本能玩**的曲子，被删掉的会直接从列表里消失，所以页面会额外拉一份**上一版曲库**
（`versions` 表里第二新的主版本，目前是 25500 → 25000）做差集：上一版有、这一版没有的就是已删除曲
（当前识别出 6 首：残響散歌、アマカミサマ，以及 4 首宴会場曲）。这些曲子照样能被搜到，专门用来给出「无法选择删除曲！」。
曲目上的 `disabled` 字段（API 文档写的"是否被禁用"）也会一并算作删除曲。

多出来的那次请求约 800KB，只影响首次载入（之后走 24 小时缓存）；把 `config.js` 里的 `checkDeletedSongs` 改成 `false` 就不拉旧曲库、也不标记删除曲。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `index.html` | 点歌页本体 |
| `style.css` | 样式（舞萌配色、响应式） |
| `app.js` | 全部逻辑：曲库加载与缓存、搜索、定数、重复检测、提交 |
| `config.js` | **唯一需要改的配置**：仓库、写入方式、凭据密文 |
| `crypto.js` | 凭据加解密（PBKDF2-SHA256 + AES-256-GCM，WebCrypto） |
| `encrypt.html` | 凭据加密器：把 Token 加密成一行密文 |
| `decrypt.mjs` | 命令行解密器 / 校验器（Node 18+，零依赖） |
| `posts.txt` | 点歌队列，一行一首，格式 `难度:曲名`，例如 `EXPERT:Chronomia` |
| `publishstate.txt` | 点歌开关，内容为 `true` 表示开放点歌（只读，只有主播能改） |
| `levelmax.txt` | 等级上限，内容为一个小数如 `13.0`（只读，只有主播能改） |

## 部署

1. 把整个目录推到 GitHub 仓库，默认分支 `main`。
2. 仓库 **Settings → Pages**：Source 选 `Deploy from a branch`，分支选 `main`、目录选 `/ (root)`。
3. 打开 `https://<你的用户名>.github.io/<仓库名>/`。页面会从地址里自动认出 `owner/repo`，
   `config.js` 里的 `owner`/`repo` 可以留空；用自定义域名访问时才需要手动填。

> 私有仓库也能用，但读 `posts.txt` 会走 GitHub API，需要凭据（见下）。

## 生成提交凭据（重要）

点歌页需要往仓库里写 `posts.txt`，所以需要一个 GitHub Token。**不要把 Token 明文写进仓库**
——公开仓库里的明文 Token 会被 GitHub 的密钥扫描自动吊销。做法是加密后再放进去：

1. 去 GitHub 建一个 **fine-grained Token**：
   - Repository access：只选 `mai_postrank` 这一个仓库
   - Permissions → Contents：**Read and write**
   - 其它权限全部留空
2. 打开 `encrypt.html`（本地双击打开也行，也可以访问 Pages 上的 `/encrypt.html`）
3. 填入 Token，点「🎲 随机」生成一个口令，点「加密」，再点「验证密文能解回 Token」确认没问题
4. 把「复制 config.js 片段」得到的两行粘进 `config.js`：

```js
  tokenBlob: 'MAI1.250000.xxxxxxxx.xxxxxxxx.xxxxxxxx',
  passphrase: '你生成的口令',
```

5. 刷新点歌页，点右下角 ⚙ → 「验证凭据」，看到 `✅ 凭据可用` 就成了。

**`passphrase` 留空**也可以：这样每次打开点歌页（新标签页）会要求输一次口令，口令只存在当前标签页的
sessionStorage 里，刷新不丢、关掉就没。适合不想把口令也公开的场合，但观众点歌时会卡在口令这一步。

命令行核对密文：

```bash
node decrypt.mjs --config            # 读 config.js 解密，Token 默认打码
node decrypt.mjs --config --show     # 打印完整 Token
node decrypt.mjs --config --check    # 顺便调 GitHub API 确认 Token 和仓库对得上
node decrypt.mjs --selftest          # 自检加解密实现
```

## 安全边界（请务必理解）

加密解决的是「Token 明文出现在公开仓库里」这个问题，**不能**让 Token 变成谁也拿不到：

- 点歌页是纯静态页面，它自己能解密，那么任何打开网页的人都能在浏览器里解出 Token。
- 想真正藏住凭据，只能让服务端代提交：`config.js` 改成 `submitMode: 'proxy'` 并填 `proxyUrl`，
  页面就会把 `{owner, repo, branch, path, line}` POST 过去，由持有 Token 的服务端（例如 Cloudflare Worker，Token 放环境变量）
  完成提交，浏览器里完全没有密钥。任何 2xx 都算成功。

Token 泄露了：先去 GitHub 吊销，再用 `encrypt.html` 生成新密文替换 `config.js` 里的 `tokenBlob`。

## 数据

- 曲库、版本、分类、中文别名来自 [落雪咖啡屋 maimai DX 查分器](https://maimai.lxns.net) 的公共 API
  （`/api/v0/maimai/song/list`、`/api/v0/maimai/alias/list`，无需鉴权）。
  首次打开会下载约 800KB 并缓存进 `localStorage`（默认 24 小时），之后秒开。
- 宴会場（宴）谱面不在公共曲库里（是 id > 100000 的独立条目，且没有 STD/DX 定数），所以选「宴」时定数区
  显示「宴会場谱面不提供定数」；但按上面的规则，「宴」和 Re:Master 一样是拦下的，宴会場曲子点不了。

## 本地预览 / 本地测试

```bash
python -m http.server 8000     # 或 npx serve .
# 打开 http://localhost:8000/
```

**请务必用本地服务器打开，不要直接双击 index.html。** 区别很大：

| 打开方式 | 结果 |
| --- | --- |
| `http://localhost:8000/`（本地服务器） | 会读**同目录**的 `publishstate.txt` / `levelmax.txt` / `posts.txt`，**五条规则照常生效**，可以放心在本地试；提交仍需配置仓库 |
| 双击 `index.html`（`file://`） | 浏览器不允许读取同目录文件 → 开关和等级上限都读不到、**规则不会生效**。页面会在横幅里明确说明这一点并让你改用本地服务器（不会默默失效） |

没配置仓库时（本地预览），页面横幅会显示读到的东西，例如
`（本地预览读到：publishstate.txt=true、levelmax.txt=13）`，一眼就能确认规则吃的是哪份配置。

要连提交一起测，就在 `config.js` 里填上真实的 `owner` / `repo`（本地不是 `*.github.io`，不会自动推断）。
