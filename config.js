/* 舞萌DX 点歌页 - 全局配置
 * 一般只需要改这一个文件。
 * owner / repo 留空时，页面会自动从 GitHub Pages 地址推断（https://<owner>.github.io/<repo>/）。
 */
window.MAI_CONFIG = {
  owner: '',
  repo: '',
  branch: 'main',

  // 点歌数据文件，相对仓库根目录
  postsPath: 'posts.txt',

  /* 点歌开关（只读！）
   * 页面只读这个文件，永远不会写它——只有主播本人能改（在 GitHub 网页上改，或本地改完 push）。
   * 规则：内容必须是 true 才允许提交；读不到 / 为空 / 是别的值，一律不接受点歌。
   */
  statePath: 'publishstate.txt',

  /* 等级上限（只读！）
   * 里面写一个小数，例如 13.0。所选难度的定数**大于**这个值就不让点歌。
   * 空文件/文件不存在 = 不设上限；写的内容不是数字 = 直接拦住并提示（免得静默失效）。
   */
  maxLevelPath: 'levelmax.txt',

  /* ------------------------------------------------------------------ *
   * 提交凭据（不要让谁自己填 Token，密文直接写在这里）
   *
   *  1. 打开 encrypt.html，填入 GitHub Token 和一个口令，点「加密」
   *  2. 把生成的两行粘到下面（tokenBlob 必填）
   *  3. passphrase 留空的话，每次打开点歌页需要手动输一次口令（只存在当前标签页）
   *
   * Token 权限只要 fine-grained 的 Contents: Read and write，范围限本仓库。
   * ------------------------------------------------------------------ */
  tokenBlob: 'MAI1.250000.pwsycuPK4KLNlsB/eh0Ojw==.o8qxjT81xkJ6R0un.PHeo7uQP04k+XqmY9ycqa8T24+Wnzd/ZetAUqvBBaG1RcIOaObLUaTfVvcC0bU7+Nc4AfwaE5IS/Bm1n+w7n296DVz5fSHiul+h2U44mSEzQlausLBWMh40JCUhTumtsIsEP1rdEsaGAUf1QCQ==',
  passphrase: '100%Security',

  /* 写入方式
   *  'blob'  —— 默认。浏览器用 tokenBlob + passphrase 解出 Token，直接调 GitHub API 提交。
   *             密文公开在网页里，所以只能挡住"随手翻源码"和 GitHub 的明文密钥扫描；
   *             要做到谁也拿不到 Token，请用下面的 proxy。
   *  'proxy' —— 服务端代提交：页面把点歌内容 POST 到 proxyUrl，由持有 Token 的
   *             Cloudflare Worker 之类负责提交，浏览器里完全没有密钥。
   */
  submitMode: 'blob',
  proxyUrl: '', // 例如 'https://mai-postrank.example.workers.dev/post'

  // 曲库数据源（公共 API，无需鉴权）
  songApi: 'https://maimai.lxns.net/api/v0/maimai/song/list',
  aliasApi: 'https://maimai.lxns.net/api/v0/maimai/alias/list',
  cacheHours: 24, // 曲库本地缓存时长
  refreshSeconds: 60, // 点歌状态 / 队列的轮询间隔（仅在页面可见时）

  // 拿上一版曲库做差集，识别"这个版本被删掉的曲子"（选到就提示「无法选择删除曲！」）。
  // 打开会在首次载入时多下载一份约 800KB 的旧曲库；关掉就没有删除曲标记。
  checkDeletedSongs: true,

  /* 点歌规则（三条门槛，文案在 app.js 顶部的 BLOCK_MESSAGES 里）
   *   'block' = 拦下：显示提示并禁用提交/复制（默认）
   *   'warn'  = 只提示，仍然可以提交
   *   'off'   = 不检查，也不提示
   */
  rules: {
    remaster: 'block', // 选 Re:Master → 「我是萌新！！无法选择！！」
    utage: 'block',    // 选 宴 → 跟 Re:Master 同理
    deleted: 'block',  // 选到已删除的曲子 → 「无法选择删除曲！」
    easy: 'block',     // 选 BASIC 且定数太低 → 「太简单了！」
    tooHard: 'block',  // 定数超过 levelmax.txt → 「太难了！」
  },

  // BASIC 谱面定数小于这个值才算"太简单"（注意是定数小数值，不是等级字符串）
  easyBasicBelow: 7,

  // 页面最底部点歌榜显示多少条（排名按 posts.txt 的文本顺序，先提交的在前）
  boardLimit: 50,

  defaultDifficulty: 'EXPERT', // 打开页面时默认选中的难度
};
