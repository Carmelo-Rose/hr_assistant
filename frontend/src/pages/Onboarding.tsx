const TAMPERMONKEY_URL =
  'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo';

function Step({
  n, title, children,
}: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="shrink-0 w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center font-semibold">
        {n}
      </div>
      <div className="flex-1">
        <h3 className="font-semibold text-gray-900 mb-1">{title}</h3>
        <div className="text-sm text-gray-600 space-y-2">{children}</div>
      </div>
    </div>
  );
}

export default function Onboarding() {
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">开始使用（一次性安装）</h2>
        <p className="text-sm text-gray-500 mt-1">
          装好脚本后，每天只需双击启动器、打开 BOSS，用页面右侧的助手面板即可。
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
        <Step n={1} title="安装 Tampermonkey 浏览器扩展">
          <p>
            在 Chrome 应用商店安装 Tampermonkey（油猴），用于在 BOSS 页面内运行助手脚本。
          </p>
          <a
            href={TAMPERMONKEY_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-block px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            打开 Tampermonkey 安装页 ↗
          </a>
        </Step>

        <Step n={2} title="一键安装助手脚本">
          <p>
            点击下方按钮，Tampermonkey 会弹出安装确认 —— 点“安装”即可。以后脚本有更新会
            <span className="font-medium">自动推送</span>，无需再手动粘贴。
          </p>
          <a
            href="/boss-helper.user.js"
            className="inline-block px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700"
          >
            安装 / 更新脚本
          </a>
          <p className="text-xs text-gray-400">
            若点击后只看到代码、没有弹出安装框，说明 Tampermonkey 还没装好，请先完成第 1 步。
          </p>
        </Step>

        <Step n={3} title="打开 BOSS 直聘开始工作">
          <p>
            登录你的 BOSS <span className="font-medium">招聘者账号</span>，进入人才搜索/推荐页。
            页面右侧会出现“BOSS 招聘助手”面板：选择岗位 → 扫描列表 → 半自动或自动打招呼。
          </p>
          <a
            href="https://www.zhipin.com/web/boss/recommend"
            target="_blank"
            rel="noreferrer"
            className="inline-block px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
          >
            打开 BOSS 直聘 ↗
          </a>
        </Step>
      </div>

      <div className="text-xs text-gray-400">
        本页面是助手的“复盘台”：扫描和打招呼在 BOSS 页面的面板里完成，这里用来看今日队列、
        AI 精评分和已发送记录。
      </div>
    </div>
  );
}
